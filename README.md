# Event Tickets

A ticket-selling service: a public catalog of events, live free-seat counts, ten-minute holds, and a small admin
page. Two api instances, a background worker and a Next.js site sit behind one nginx.

## Run it

One manual step:

```bash
cp .env.example .env
docker compose up --build
```

Then open <http://localhost:8080>. Only nginx is published; everything else stays on the private Docker network.
(Change the port with `WEB_HOST_PORT` in `.env`.)

The values in `.env.example` are **demo values for local use**. For anything else, make your own
(for example `openssl rand -hex 32`).

| What | Where |
| --- | --- |
| Site | <http://localhost:8080> |
| API docs (Swagger) | <http://localhost:8080/docs> (also at `/api/docs`) |
| OpenAPI file | <http://localhost:8080/openapi.json> |
| Health / readiness | `/api/health`, `/api/ready` |

Demo accounts (passwords are in `.env.example`): `admin@example.com` (administrator), `alice@example.com`,
`bob@example.com`. The database starts with 200 events in 8 cities.

## What is in the repository

```
apps/api       Express API (feature modules: module.routes / controller / service / repository)
apps/worker    Background jobs: expire holds, tell the site about edited events, clean up
apps/web       Next.js site (feature folders under src/features)
packages/shared  Schemas and rules used by all of them (zod)
packages/db    Drizzle schema, versioned SQL migrations, seed
infra/nginx    The only door into the stack: cache, request ids, routing
e2e            Browser tests (Playwright)
loadtest       The "300 requests for 20 seats" test (autocannon)
```

`map.md` is a guided tour of the code, in the order it is best read.

## How it fits together

```
browser ──► nginx ──► web (Next.js) ──► api1 ┐
              │                         api2 ├──► PostgreSQL
              └──────► api (direct, /api) ───┘ └─► Redis (sessions, cache, rate limit, queue, live seats)
                                          worker ──► PostgreSQL / Redis ──► web (/internal/revalidate)
```

* **No oversell, enforced by the database.** `events.booked_seats` is kept in step by triggers, and a
  `CHECK (booked_seats <= capacity)` makes it impossible to go over, whatever the code does. Booking is one
  transaction; "not enough seats" is an ordinary 409.
* **Idempotent booking.** `POST /events/:id/bookings` needs an `Idempotency-Key`. The same key and the same
  body return the first answer again (`Idempotent-Replay: true`); the same key with a different body is a 422. The key
  is a unique row (user, key) that commits together with the booking, so two identical requests at the same moment
  make one booking.
* **Edits with versions.** `PATCH /events/:id` carries the version it was based on. A stale version gets 409 and the
  saved event (the admin form shows it). Capacity cannot go below the seats already taken. Version check and change
  are one statement.
* **Holds expire.** The worker turns held bookings past their time into expired ones and frees the seats. A late
  confirm is also refused by the api (and frees the seats at once).
* **Edits reach the site.** A trigger writes a note to an `outbox` table. The worker makes one job per note
  (job id = event + version, so no duplicates). Each job first moves the api's cache generation (so an edit made by
  hand in SQL is not served from the api's cache either), then calls the site's signed `/internal/revalidate` with
  exponential pauses between tries, and only then checks the note off.
* **Sessions** live in Redis behind an `httpOnly`, `SameSite=Lax` cookie; passwords use argon2.
  Cross-site writes are refused (`Origin` check).
* **Request id.** nginx makes one per request and passes it to the site (`proxy.ts` logs it and returns it in the
  `x-request-id` header), the api and, for edits, through the outbox to the worker; every JSON log line carries it.
* **Real client address.** nginx overwrites `X-Forwarded-For`; the api trusts exactly one proxy. The site passes the
  visitor's address on in signed headers (secret `INTERNAL_API_SECRET`) that nginx removes from anything a browser
  sends. Rate limits count that address, not nginx's.

### Database rules (where to find them)

The guarantees that must hold whatever the code does live in the database, in `packages/db/`:

| Rule | Where |
| --- | --- |
| `booked_seats` never above `capacity`, never negative; capacity above 0; quantity 1 to 4; idempotency key length | `CHECK` constraints declared in `src/schema.ts` (Drizzle generated `migrations/0000_init.sql` from them) |
| `booked_seats` follows the bookings that are `held` or `confirmed`; the update locks only that event's row | trigger `bookings_sync_seats` in `migrations/0001_triggers.sql` |
| `version` goes up only when the content of an event changes | trigger `events_bump_version` (same file) |
| every event change writes a note to `outbox` (also an edit made by hand in SQL), with the request id | trigger `events_enqueue_outbox` (`0001`, replaced in `0002_outbox_request_id.sql`) |
| a booking only moves `held` to `confirmed`, `cancelled` or `expired`, or `confirmed` to `cancelled`; its event and owner never change (error `BK001`) | trigger `bookings_guard` (`0001`) |

Drizzle's schema language cannot describe triggers, so they are **custom migrations** (`pnpm --filter @app/db db:generate:custom`).
They run in order with all the others, once, by the `migrate` service before the apps start. Always use the migrations,
never `drizzle-kit push`: `push` does not know about the triggers. `packages/db/test/seats.test.ts` runs the real
migrations and tries to oversell.

### Cache table

| Layer | What | How long | Cleared by | Worst case old data |
| --- | --- | --- | --- | --- |
| Browser | pages are sent `no-store`; api answers carry an `ETag` and no lifetime; static files (`/_next/static`) are cached for a year but their names change with every build | none for data | not needed | none. In-app links ask the server again (a test edits an event and follows links without reloading) |
| nginx | public pages (`/`, `/events/…`) for visitors without a session cookie | 5 s | time. Pages with a cookie, `/me`, `/checkout`, `/admin`, `/login`, `/register`: never (`X-Cache-Status: BYPASS`); answers with `Set-Cookie` are never saved | 5 s after an edit (plus the ~0.3 s the worker needs to refresh the site, see next row) |
| Next.js `use cache` | event, event list, cities | fresh up to 5 min, hard limit 1 h | tags `event:<id>`, `events`, `cities`: the worker calls `/internal/revalidate` after every edit; the admin form clears them itself | about 1 s normally. If the worker or the site is down: until the worker retries (growing pauses), at most the 1 h limit |
| api level 1 (memory) | events, lists, cities | 10 s, 1000 entries, least recently used out | pub/sub: any edit (through the api, or made by hand in the database via the worker) moves a *generation number* that is part of every key | immediate on a healthy Redis; 10 s if a pub/sub message is lost |
| api level 2 (Redis) | the same | 60 s | the same generation number | immediate; 60 s without Redis messages |
| api, "not found" | missing events | 15 s | the generation number | 15 s (an event created in that window) |
| api, free seats | `GET /events/:id/availability` | 1 s, memory only | time; every booking also drops the local copy and announces the new number (SSE) | 1 s |

So after a direct `PATCH` the card and the list show the change within 5 s plus a fraction of a second (the nginx
copy that was made just before the edit lives its full 5 s; the worker has refreshed the site long before it ends).

A Redis lock plus a second look makes 100 simultaneous requests for a cold event over both api instances one
database query (a test checks this).

### Live seats

`GET /events/:id/stream` (Server-Sent Events) sends the current number and then every change. The event page
shows it live; nginx does not buffer it.

## Tests

```bash
pnpm install
pnpm lint && pnpm typecheck
pnpm test        # api, worker, web, shared, db. Needs Docker (Testcontainers start PostgreSQL and Redis)
```

The api and worker tests run on a **real** PostgreSQL and Redis, not mocks. Examples of what they check:

* 300 booking requests for 20 seats, over both api instances: exactly 20 succeed.
* 20 identical requests (same key) make one booking; the same key with a different body is a 422.
* 20 editors with the same version: exactly one wins, the rest get 409 with the saved event.
* 100 cold requests for one event over both instances: one database query.
* A change made on one instance is seen on the other at once (40 rounds).
* A confirm after expiry is refused and frees the seats; other people's bookings look like they do not exist.
* Login: 5 tries per account per 15 minutes; a wrong address header cannot dodge the limit.
* Stopping an api with open live streams exits with code 0 in well under a second.
* Worker: no duplicate delivery with several workers, retries after failure, restart loses nothing.

Browser tests (Playwright) need the stack running:

```bash
cp .env.example .env && docker compose up --build -d --wait
pnpm --filter @app/e2e exec playwright install chromium   # once
pnpm e2e
```

They cover (17 tests): register, book and confirm; a stale page asking for too many seats (error, nothing changes); a real 404
status for a missing event; one user cannot see another's booking; an admin edit visible within 5 s; the admin
conflict view; nginx `HIT` for visitors and `BYPASS` with a session; a request id on every answer; a wrong password;
admin page closed to others; the checkout timer running out; a second tab following the free seats; cancelling with
rollback and the header counter; keyboard-only sign-up and booking with errors tied to fields; the seat count refused
with 429 while the rest of the card still shows; an edit shown after navigating with in-app links only.

## Load test

300 requests fight for the last 20 seats of one event (one user, a new `Idempotency-Key` per request, 50 at a time).
The load test sends about 310 requests in one minute from one address. The default limit is 600 per minute per
address (`RATE_LIMIT_MAX`), so it runs with the normal settings:

```bash
docker compose up --build -d --wait
pnpm loadtest        # needs Node 22.18 or newer on your machine
```

Result on the development machine (laptop, everything in Docker):

```
requests sent:         300
201 booked:            20
409 sold out:          280
free seats afterwards: 0
latency p50 / p97.5 / p99: 74 / 153 / 160 ms
throughput:            300 requests per second (average)
PASS: exactly the free seats were sold, nothing more.
```

## Build output of the site

`next build` (Next.js 16.4.5) prints this route table (during `docker compose build web`; use
`docker compose build web --progress=plain` to see it):

```
Route (app)
┌ ◐ /
├ ◐ /_not-found
├ ◐ /admin/events/[id]
├ ◐ /checkout/[bookingId]
├ ◐ /events/[id]
│ ├ ◐ /events/167
│ ├ ◐ /events/176
│ └ ◐ [+28 more paths]          <- the 30 prerendered events
├ ○ /healthz
├ ○ /icon.svg
├ ƒ /internal/revalidate
├ ◐ /login
├ ◐ /me/bookings
└ ◐ /register

○ (Static)             prerendered as static content
◐ (Partial Prerender)  prerendered as static HTML with dynamic server-streamed content
ƒ (Dynamic)            server-rendered on demand
```

Next.js 16 no longer prints "First Load JS" itself, so `apps/web/scripts/first-load-js.mjs` works it out from the build
files (gzip sizes, `pnpm --filter @app/web first-load-js` after a build):

```
Route                              First Load JS (gzip)
/                                      227.4 kB
/events/[id]                           224.6 kB
/checkout/[bookingId]                  227.5 kB
/me/bookings                           227.1 kB
/login, /register                      224.6 kB
/admin/events/[id]                     226.3 kB
Shared by every page:                  167.9 kB
```

(The shared part is React and the Next.js runtime.)

## Decisions

* **Express + feature modules, functional style.** No classes: every module is a function that receives what it
  needs (`createXService(deps)`).
* **Drizzle with versioned SQL migrations.** Triggers and checks are in migrations, so the guarantees live in the
  database. `migrate` runs once as its own compose service before the apps start.
* **Redis for five jobs** (sessions, cache level 2 and pub/sub, rate limit counters, queue, live-seat channel).
  The cache's generation number comes from the Redis clock so it never goes backwards, even if Redis loses its data.
* **Next.js cache components.** `use cache` with tags rather than a time-based `revalidate`, so an edit can be shown
  at once; a time limit is only the last resort. Thirty events (the nearest ones) are prerendered; other ids render
  on first visit; a missing id is a real 404.
* **Optimistic UI.** Booking and cancelling show the result at once and roll back with a message if the server says no.
* **Secrets.** Nothing secret has a default in code, Dockerfiles or compose. `.env.example` holds demo values only.
  The api refuses to start with a missing or too-short secret. Client bundles were scanned for the secret, the
  database and Redis addresses and the internal api address: none appear.
* **Same domain for everything.** The site and `/api` are behind one origin, so the session cookie needs no CORS.
* **English interface.**

## Limitations (honest list)

* **Closed pages and their status codes.** `src/proxy.ts` checks before anything is sent: a visitor who is not logged in
  gets a real `307` to `/login?next=...` on `/me/*`, `/checkout/*` and `/admin/*`, and a logged-in user who is not an
  administrator gets a real `403` on `/admin/*` (an administrator is checked with the api; if the api cannot answer, the
  page decides and shows its own error). On `/me` and `/checkout` the proxy only looks for a session cookie, so a cookie
  that is no longer valid gets the page, which then sends the visitor to log in (status 200, redirect inside the page).
* The checkout page for someone else's booking shows the "not found" page but with status 200 (the proxy does not know
  who owns a booking; the page streams); the api answers 404 for it. A missing **event** page is a real 404.
* One Redis and one PostgreSQL: no replication or failover.
* Payments are not real: "Confirm" only confirms the booking.

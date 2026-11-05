# map.md: a guided tour of the night shift

Started 2026-11-05 00:16, hard stop 03:16 (3 hours). Rules: no git, assignment first, tests that hunt real bugs,
stop if stuck on one bug after ~10 attempts.

Read this top to bottom. Each section says: what was built, which files, how to try it, and what the tests prove.
Anything not finished or not verified is listed under "Known gaps" at the bottom.

## 0. Before you start (do this first)

My changes added new settings. Your `.env` is older than `.env.example`, so re-copy it once:

    cp .env.example .env
    docker compose up --build

(Nothing in `.env` was customised, so nothing is lost.)

How to run the tests (needs Docker running):

    pnpm test            # everything
    pnpm --filter @app/api test

Every test file that needs a database shares ONE Postgres and ONE Redis that start automatically
(`apps/api/test/global-setup.ts`); each file gets its own fresh copy of the database.

## Progress

| Slice | Status |
| --- | --- |
| A. Auth (register, login, logout, me) | done, tested |
| B. Events, search, pagination, two-level cache | done, tested |
| C. Bookings, idempotency, edit with version | done, tested |
| D. Rate limit and trusted client address | done, tested |
| E. Live seats (SSE) | done, tested |
| F. Worker (expiry, refresh of the web app, cleanup) | done, tested |
| G. Web app (Next.js) | done, built, unit + browser tested |
| H. Docker for all services, nginx cache | done, checked on the real stack |
| I. Browser tests, load test, README, CI | done (CI workflow not run on GitHub yet) |

## A. Auth

What it does: `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET /me`. Sessions live in Redis,
the cookie is `httpOnly` + `SameSite=Lax`, passwords are argon2.

Walk through the files in this order:

1. `packages/shared/src/auth.ts`: the rules for register/login bodies (email trimmed + lower-cased, password 8-128,
   unknown fields rejected so nobody can register as admin) and the public user shape (no password hash).
2. `apps/api/src/modules/auth/session-store.ts`: create / find / destroy a session in Redis. Only a hash of the
   session id is stored. `find` renews the session.
3. `apps/api/src/modules/auth/password-hasher.ts`: argon2 hash/verify, plus `verifyNothing` so a login for an
   unknown email takes as long as a real one.
4. `apps/api/src/modules/auth/users.repository.ts`: the database queries.
5. `apps/api/src/modules/auth/auth.service.ts`: register / login / logout / "who is behind this cookie".
6. `apps/api/src/middleware/auth.ts`: reads the cookie on every request; `requireUser`, `requireAdmin`;
   `requireSameOrigin` blocks requests another website made with the visitor's cookies.
7. `apps/api/src/modules/auth/auth.controller.ts` + `auth.routes.ts`: the HTTP part and the docs entries.

Try it: open http://localhost:8080/api/docs, register, then call `GET /me` (the browser keeps the cookie).
Demo logins are in `.env.example` (admin@example.com / Admin-Demo-Pass-1, alice@..., bob@...).

Tests: `apps/api/test/auth.test.ts` (35), `session-store.test.ts` (29), `password-hasher.test.ts` (18),
`packages/shared/test/auth.test.ts` (22). Each was checked by breaking the code on purpose (leaking the hash,
user enumeration, cross-site requests, logout not ending the session, duplicate-registration race, ...).

## B. Events and the two-level cache

What it does: `GET /events` (city, dates, text search, cursor pagination), `GET /events/:id`,
`GET /events/:id/availability`, `GET /cities`.

Files, in order:

1. `packages/shared/src/events.ts`: schemas (query, event, page, availability, the edit body for slice C).
2. `apps/api/src/modules/events/query-helpers.ts`: pure helpers: search text -> safe Postgres query, cursor
   encode/decode, date ranges ("to=2026-12-31" includes the whole day).
3. `apps/api/src/modules/events/events.repository.ts`: the SQL (keyset pagination on (startsAt, id)).
4. `apps/api/src/infra/cache/memory-cache.ts`: level 1: TTL + size limit + least-recently-used eviction.
5. `apps/api/src/infra/cache/two-level-cache.ts`: level 1 + Redis level 2. Read the comments at the top: how many
   callers share one load, how the Redis lock makes two instances do ONE database query, how "not found" is
   remembered, and how a *generation number* (part of every key) clears everything on every instance at once
   (Redis pub/sub). Generation numbers are based on the Redis clock so they never go backwards, even if Redis
   loses its data (a test found that bug).
6. `apps/api/src/modules/events/events.service.ts`: which things are cached and for how long.
7. `events.controller.ts`, `events.routes.ts`: HTTP and docs.

Try it: `GET /api/events?city=London&q=concert`, follow `nextCursor`; open an event twice and watch the api log
(only the first one reads the database).

Tests: `events.test.ts` (53), `cache.test.ts` (34), `memory-cache.test.ts` (8), `query-helpers.test.ts` (20).
Highlights: 100 simultaneous requests over BOTH instances = ONE database query; change on one instance visible
on the other immediately (40 rounds); pagination with identical start times; hostile search text; Redis failure.

## C. Bookings, idempotency, admin edit

Endpoints: `POST /events/:id/bookings`, `POST /bookings/:id/confirm`, `DELETE /bookings/:id`, `GET /me/bookings`,
`PATCH /events/:id` (administrators).

Files, in order:

1. `packages/shared/src/bookings.ts`: schemas, `Idempotency-Key` rules.
2. `apps/api/src/modules/bookings/bookings.repository.ts`: the SQL, including the idempotency queries.
   Read `claimKey`: the database's unique key makes a second identical request wait for the first, then see "already there".
3. `apps/api/src/modules/bookings/bookings.service.ts`: the booking transaction. Key points: the key and the
   booking commit together; a nested transaction (savepoint) lets a "sold out" answer be saved too; the free-seat
   count is read inside the same transaction (reading it through a second connection deadlocked the pool under
   300 simultaneous requests: the test found that).
4. `bookings.controller.ts`, `bookings.routes.ts`: HTTP and docs.
5. `apps/api/src/infra/seats-notifier.ts`: after any change in free seats, forgets the local cached number and
   announces the new number (bursts become one message).
6. `PATCH /events/:id` lives in `modules/events/`: `events.repository.ts` (`update`), `events.service.ts` (`update`).
   Version check and change are ONE statement; a conflict answer carries the saved event so a form can show it.

Tests: `apps/api/test/bookings.test.ts` (79). Highlights: 300 requests for 20 seats over both instances give exactly 20
winners; 20 identical requests at once make one booking; a late confirm is refused AND frees the seats at once;
other people's bookings look like they do not exist; 20 editors with the same version: exactly one wins.

## D. Rate limit and the client address

Files: `apps/api/src/infra/rate-limiter.ts` (counters in Redis, one atomic step), `middleware/client-ip.ts`
(who is calling), `middleware/rate-limit.ts`, `modules/auth/login-guard.ts` (stricter login limits),
`packages/shared/src/internal.ts` (signed calls between our own programs).

How the address is decided: a call from our own web server carries a signature made with `INTERNAL_API_SECRET`
and says which visitor it speaks for; otherwise the address nginx put in `X-Forwarded-For` (nginx replaces whatever
the browser sent); a browser cannot send the signed headers (and nginx removes them anyway).
Calls from the web server that are not for a visitor (cached pages) are not counted.

Tests: `apps/api/test/rate-limit.test.ts` (28), `packages/shared/test/internal.test.ts` (17).
Login: 5 tries per account per 15 minutes (the 6th is refused even with the right password), 20 per address.

## E. Live seats (SSE)

`GET /events/:id/stream`: sends the current number, then one message per change, with a keep-alive line.
Files: `apps/api/src/infra/seats-hub.ts` (every instance listens to Redis and passes messages to its own open
streams), `modules/events/events.controller.ts` (`stream`), nginx `location ~ ^/api/events/[0-9]+/stream$`.
Shutdown closes open streams (`lifecycle.onShutdown` in `main.ts`), and connections are closed after their last
answer (`middleware/connection-close.ts`): stopping an api with open streams takes ~0.2 s (a test found it took 6 s).

Tests: `apps/api/test/stream.test.ts` (18), `lifecycle.test.ts`.

## F. Worker

`apps/worker`: BullMQ. Files: `src/worker.ts` (starts everything), `src/jobs/expire-bookings.ts`,
`src/jobs/outbox.ts` (notes about changed events -> jobs), `src/jobs/revalidate.ts` (signed call to the web app),
`src/jobs/cleanup.ts`.

Flow for "an event was edited": the database trigger writes a note in the `outbox` table (also for edits made by
hand in SQL); the api wakes the worker; the worker makes a job per note (job id = event + version, so no
duplicates); the job calls the web app's refresh endpoint with exponential pauses; only after success is the note
checked off. Jobs live in Redis, so a restart loses nothing.

Tests: `apps/worker/test/expiry.test.ts` (10), `revalidate.test.ts` (19). Each test gets its own database and workers.

## G. Web app (`apps/web`)

Feature folders: `src/features/<feature>/` each has `index.ts` (safe for the browser) and `server.ts(x)` (server
only). Pages in `src/app/` only put features together. ESLint forbids reaching into another feature's files.

Read in this order:

1. `src/shared/config/env.ts`, `shared/api/api-client.ts` (the only way the site talks to the api; adds the request id
   and the signed visitor address), `shared/api/browser-api.ts` (calls from the browser, same origin `/api`).
2. `src/features/event/queries.ts`: `use cache` + `cacheTag`; this is where the Next.js cache lives.
3. `src/app/page.tsx` + `features/catalog/` (filters live in the URL, a date like 2026-02-30 is refused).
4. `src/app/events/[id]/page.tsx`: 30 events prerendered (`generateStaticParams`), the rest on first visit,
   missing id = real 404 (`not-found.tsx`). Do NOT add a `loading.tsx` above this route: it would turn the 404 into a 200.
5. `features/availability/` (live seats from the stream; reconnects with growing pauses if it drops) and
   `features/booking/` (optimistic booking: the number drops at once, rolls back with a message if refused).
6. `features/checkout/` (countdown that follows the server's `expiresAt`, confirm, cancel),
   `features/my-bookings/`, `features/auth/` (login/register forms with server-side field errors).
7. `features/admin-event/` + `app/admin/events/[id]/page.tsx`: Server Action with the version; on a 409 the form shows
   what is saved now and keeps what the admin typed.
8. `src/app/internal/revalidate/route.ts`: what the worker calls (signed; nginx hides it from the outside).

Try it: log in as alice, open any event, book 2 tickets, watch the countdown, confirm; open the same event as an
anonymous visitor in another browser: the number follows live.

Tests: `apps/web/test/*.test.ts` (41, pure logic: debounce, booking intent/rollback, filters). The pages themselves are
covered by the browser tests (J).

## H. Docker and nginx

`docker-compose.yml` (one file): postgres, redis, `migrate` (runs once, also seeds), api1, api2, worker, web, nginx.
Only nginx publishes a port. Each app has a multi-stage `Dockerfile` (build stage, small runtime stage, non-root
user) and a healthcheck. `infra/nginx/nginx.conf` + `snippets/`: routing, the 5-second page cache, request id, SSE.
The web image builds the site against a temporary Postgres/Redis/api inside the build stage (pages are prerendered
with real data), then throws them away.

Checked on the real stack: all services healthy; `docker stop` of api, web, worker and nginx under traffic exit with
code 0 in well under a second; page `HIT`/`MISS`/`EXPIRED` for anonymous and `BYPASS` with a session; `/internal/*`
from outside is 404; the client JavaScript contains none of the secrets or internal addresses.

## I. Browser tests, load test, README, CI

* `e2e/` (Playwright, 7 scenarios): `pnpm e2e` against the running stack. Login is rate limited, so each user logs in
  once per run and the cookie is reused. `e2e/tests/flows.spec.ts`.
* `loadtest/book-last-seats.ts` (`pnpm loadtest`): 300 requests, 20 seats, expects 20 x 201 and 280 x 409.
  Needs `RATE_LIMIT_MAX=5000 docker compose up -d` because the normal limit is 300 per minute.
* `apps/web/scripts/first-load-js.mjs`: First Load JS per page (Next 16 does not print it).
* `.github/workflows/ci.yml`: lint, typecheck, tests; then the whole stack, browser tests and load test.
* `README.md`: how to run, cache table, decisions, limitations.

## Known gaps

* Edits made by hand in SQL reach the worker and the site's cache, but not the api's own cache, so they can look old for
  up to a minute (and the site may keep that old copy). Edits through the api are consistent. (Fix idea: the worker
  publishes the cache generation bump to Redis before it calls the site.)
* Someone else's checkout page shows "not found" with status 200 (it streams). The api returns a real 404.
* The site does not log every page view; request ids are in the nginx and api logs for every call, and in the
  worker/web logs for edits.
* The CI workflow was written but never run on GitHub; everything it runs was run locally.
* Browser tests run in Chromium only.

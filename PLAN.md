# Plan: Event Ticketing Service

Source of truth: `test-assignment-3.md` (the assignment always wins over this file).
This file is the working plan. The assignment's 27 acceptance checks are mapped in section 11.

## 0. Working agreement

- One step at a time. After each step we both read what was written, then the next step starts.
- No `git` commands until the user asks. When asked: one commit per phase.
- A phase is done only when its acceptance checks (section 11) pass.
- Functional style everywhere (no classes).

## 1. Decisions fixed

| Topic | Decision |
| --- | --- |
| Package manager | pnpm workspaces, Node 22, TypeScript strict, single lockfile in the root |
| Backend | Express 5, modules `modules/<m>/<m>.{routes,controller,service,repository}.ts`. Drizzle + `drizzle-kit` migrations. Zod schemas in `@app/shared`. OpenAPI from the same schemas via `@asteasolutions/zod-to-openapi`, served at `/docs` |
| Style | Factory functions with injected dependencies + pure functions. `eslint-plugin-functional` bans classes. Side effects only in `main.ts` and adapters |
| Frontend | Next.js 16, `cacheComponents: true`, `partialPrefetching: false`, React 19, shadcn/ui, **feature-based** structure |
| Cache in `web` | `use cache` + `cacheLife` + `cacheTag`. No `revalidate` / `dynamic` / `dynamicParams` segment configs (they error under `cacheComponents`) |
| Queue | BullMQ on Redis |
| Load test | autocannon |
| Config | One `.env.example` copied to `.env`. An `env.ts` per app with zod. **Required, no default:** secrets, `DATABASE_URL`, `REDIS_URL`, internal addresses. **Defaults allowed:** ports, TTLs, limits. Missing required variable -> clear message -> exit 1. `docker-compose.yml` uses `${VAR:?...}`, never `${VAR:-...}`. Dockerfiles have no secret `ENV`/`ARG` |
| nginx page cache | Exactly 5 s. Fast invalidation keeps the worst case small; README states it honestly |

## 2. Repository layout

```
apps/api/src/
  modules/{auth,events,bookings,cities,health}/   *.routes|controller|service|repository.ts
  infra/{config,db,redis,cache,rate-limit,logger,sse,openapi}/
  middleware/{request-id,client-ip,auth,validate,error-handler}.ts
  main.ts                    # composition root + graceful shutdown
apps/worker/src/{jobs,infra,main.ts}
apps/web/src/
  app/                       # thin routes only
  features/                  # see section 5
  shared/                    # ui (shadcn), api client, env, hooks, lib
packages/shared/src/         # zod schemas, types, error codes, OpenAPI registry
infra/{nginx,docker}/  load-test/  scripts/  .github/workflows/
```

`@app/shared` exports `.ts` source, so typecheck works from the root before any build (check 4).
`web` uses `transpilePackages`; `api` and `worker` are bundled with tsup.

## 3. Data (assignment section 1)

- Tables: `users`, `events`, `bookings`, `idempotency_keys`, `outbox`.
- No overselling, enforced in the database:
  - `events.booked_seats` with `CHECK (booked_seats BETWEEN 0 AND capacity)`.
  - Trigger on `bookings` adds/subtracts `quantity` on insert and on status moves between `held`/`confirmed` and `cancelled`/`expired`.
  - Check violation `23514` -> `409`.
  - Concurrency uses the per-event row lock only, never a table lock.
- `version` and `updatedAt` change only when `title`, `description` or `capacity` change, never from booking traffic.
- `outbox`: a trigger on those columns inserts a row (covers edits made by raw SQL).
- Indexes: generated `tsvector` + GIN for full-text search; `(starts_at, id)` for cursor pagination.
- Seed: 200 events, 8 cities, next 3 months; 3 users (one admin); runs only if the events table is empty. Credentials in README.

## 4. Backend behaviour (assignment sections 2 and 3)

**Auth.** argon2; session id (32 random bytes) in Redis `sess:<hash>`, 7-day TTL; cookie `httpOnly`, `SameSite=Lax`; mutations also check `Origin`.

**Events API.** `GET /events` (city, date range, FTS with `simple` config + prefix match, keyset cursor on `(startsAt, id)`), `GET /events/:id` (404 if missing), `GET /cities`, `PATCH /events/:id` (admin; `UPDATE ... WHERE id AND version`; 409 on conflict; 409 if capacity < booked seats).

**Bookings.**
- `POST /events/:id/bookings` requires `Idempotency-Key`: same key + same body replays the stored response; different body -> 422; concurrent duplicates wait for the first result. Quantity 1-4.
- `confirm` is rejected once `expiresAt` has passed, even before the worker marks it expired.
- `DELETE` cancels a held or confirmed booking; an `expired` one -> 409.
- `GET /me/bookings`.

**Errors / OpenAPI / health.** One shape `{code, message, details}`; zod issues become human text per field. `/health` = process alive. `/ready` = PG + Redis reachable, 503 while draining.

**Two-level cache** (list, event, cities):
- L1: in-process LRU with TTL and max size, with single-flight.
- L2: Redis. On an L2 miss one instance takes a short `SET NX` lock and queries Postgres; the other waits and re-reads. 100 concurrent requests across both instances -> 1 DB query.
- Missing event cached ~30 s. Ids that are not positive integers get 404 from validation without touching cache or DB.
- `PATCH` clears L2 and publishes an invalidation on Redis pub/sub; every instance clears L1. The worker publishes the same message from the outbox (raw-SQL edits).
- Availability is cached at most 1 s.

**Rate limit.**
- Lua script in Redis, shared by both instances, keyed by end-user IP.
- nginx overwrites `X-Forwarded-For` with `$remote_addr`; `api` uses `trust proxy` with 1 hop for requests that came through nginx.
- `web`'s per-user server calls send `X-End-User-IP` + an HMAC signature; `api` trusts it only if the signature verifies.
- Fetches inside `use cache` carry no user IP, so rendering the shared cache never spends a visitor's limit.
- `POST /auth/login`: stricter limit, by IP and by email.
- The general limit must trip on 1000 distinct non-existent ids.

**SSE.** `/events/:id/stream` sends the current value on connect, then updates from Redis `availability:<id>`, plus heartbeats. `api` publishes on every booking change; the worker publishes on expiry.

**Logs / config / shutdown.** pino JSON. Request id from nginx `$request_id` -> `AsyncLocalStorage` -> every log line -> BullMQ job data -> worker call to `web` -> `web` logs. On `SIGTERM`: `/ready` 503, stop accepting, end SSE, finish in-flight requests, close PG/Redis, exit 0.

**Worker** (BullMQ, no HTTP):
- Expiry job: repeatable with a fixed `jobId`; marks `held` rows past `expiresAt` as `expired`; the trigger frees seats; publishes new availability.
- Fast path: right after a `PATCH` commits, `api` enqueues the revalidation job (`jobId = revalidate:<eventId>:<version>`).
- Safety net: outbox poller (`FOR UPDATE SKIP LOCKED`, ~500 ms) enqueues the same job id for anything missed.
- Revalidation job: signed request to `web`, exponential backoff, survives restarts (jobs live in Redis).
- Shutdown: stop taking jobs, finish the current one, exit 0.

## 5. Frontend (assignment section 4), feature-based

```
features/
  catalog/          filters, results, load-more, search race guard, cached list query
  event/            card, cached getEvent, generateStaticParams helper
  availability/     seats block, SSE hook with backoff, error boundary
  booking/          reserve form, BookingsProvider (optimistic), idempotency key hook
  checkout/         countdown (server time), confirm/cancel
  my-bookings/      list, optimistic cancel
  auth/             login/register forms, session query, header user menu
  admin-event/      edit form, Server Action, conflict view
shared/             ui (shadcn), api client (server-only), env, hooks, lib
```

Rules: `app/*` imports only from a feature's public `index.ts`; features never import each other's internals; `shared` imports nothing from features; a lint rule enforces this; `'use client'` only where needed.

**Caching in `web`.**
- `getEvent(id)` tagged `event:<id>`; list function (filters + cursor as arguments) tagged `events`; cities tagged `cities`.
- Free seats, session, name, bookings are never inside `use cache`; each sits in its own `<Suspense>` + error boundary (a `429`/`500` in one block does not break the page).
- Internal revalidate route: verifies HMAC, calls `revalidateTag(tag, { expire: 0 })`. Admin Server Action calls `updateTag`.

**Pages.**
- `/events/[id]`: no `loading.tsx`, no `dynamicParams`. `generateStaticParams` returns the 30 nearest events. The page awaits `params` outside `<Suspense>`, validates the id, loads the cached event, calls `notFound()` before streaming (real 404 for `/events/999999` and `/events/abc`). Loading state = Suspense fallbacks. Seats: streamed value, then SSE takes over and reconnects with increasing delay.
- `/`: filters in the URL; change -> `router.push` after debounce (Back restores filters). "Show more" = client fetch of `/api/events?cursor=` with `AbortController` + request counter so an old response never overwrites a new one. Has `loading.tsx`, `error.tsx`.
- `/checkout/[bookingId]`: countdown from server `expiresAt` + server-time offset; after expiry confirm is disabled and the page says so.
- `/me/bookings`: optimistic cancel with rollback + message.
- `/login`, `/register`: labels, `aria-describedby`, human error text.
- `/admin/events/[id]`: non-admins redirect to `/login`. On `409` the form shows the saved version beside the user's input and keeps both.

**Optimistic UI.** `BookingsProvider` with `useOptimistic` also drives the header counter (`held` + `confirmed`, so it matches after reload). Pure reducer, unit-tested. `409` rolls everything back with a message. Idempotency key created once per intent (double click = one request).

**Client rules.** Browser calls go to relative `/api/*` through nginx. No `NEXT_PUBLIC_` variables for anything server-side; server env is read in a `server-only` module. A script searches built client chunks for the `api` address, secrets and variable names (check 24).

## 6. Infrastructure (assignment section 5)

- Compose: `postgres`, `redis`, one-shot `migrate`, `api` x2, `worker`, `web`, `nginx`. Only nginx publishes a port.
- `migrate`: one-shot service that migrates, then seeds only if the tables are empty. It is the only process that migrates; `api` and `worker` wait for `service_completed_successfully` and never migrate themselves, so there is no race.
- Healthcheck on every service; `depends_on` uses `service_healthy`.
- Dockerfiles: multi-stage, built at `docker build`, non-root user. `web`: `output: 'standalone'`, copies `.next/static`, small wrapper around the standalone server that handles `SIGTERM` and exits 0.
- Build-time prerender of the 30 events: the `web` build stage installs Postgres + Redis, starts them with throwaway values generated inside that `RUN`, migrates, seeds, starts `api`, runs `next build`, stops everything. Documented in README.
- nginx: overwrites `X-Forwarded-For`; sets `X-Request-Id` from `$request_id`; JSON logs. `proxy_cache` 5 s only for `GET /` and `/events/*`; bypass when the session cookie is present; never store responses with `Set-Cookie`; bypass requests with the `RSC` header; `X-Cache-Status` header. `/api/*` never cached. SSE: buffering off, long read timeout.
- CI (GitHub Actions): install, lint, typecheck, tests with Postgres + Redis services, image builds.
- Load test: autocannon, 300 requests on the last 20 seats, plus a DB oversell check; results in README.
- Build output: `next build` output + bundle report script for First Load JS per page.

## 7. Tests (assignment section 6)

- **api** (real Postgres + Redis via Testcontainers, two app instances in one process): L1, L2, cross-instance invalidation, negative cache; 100 concurrent cold requests -> 1 DB query (counted at the pool); rate limit; 300-vs-20 with exact counts; idempotency incl. 422; 409 on version conflict.
- **worker**: expiry; revalidation retries against a fake `web` that is down then up; no duplicate jobs from two workers.
- **web unit**: optimistic reducer, debounce, stale-response guard.
- **e2e (Playwright)**: booking catalog -> confirmation; rollback on insufficient seats; real 404; admin edit visible in card and list; one user's bookings invisible to another; nginx `HIT` for anonymous, `BYPASS` for logged-in.

## 8. README (assignment section 7)

Run (local + Docker), tests, load test, architecture diagram, cache table (data / layer / TTL / invalidation / worst-case staleness; a check compares TTLs with real config), decisions, limitations.

Decisions to record: numeric ids; counter = `held` + `confirmed`; cancel rules; session TTL; FTS config; how `.env.example` + `env.ts` interpret "no default secrets"; nginx worst case; build-stage approach.

## 9. Phases

1. Scaffold: workspaces, TS, lint (functional + boundary rules), `shared`.
2. DB: schema, migrations, triggers, constraints, seed.
3. `api` core: env, logs, request id, errors, health, OpenAPI, shutdown.
4. Auth.
5. Events read path + two-level cache.
6. Bookings, idempotency, `PATCH`.
7. SSE, rate limits, `api` tests.
8. Worker + tests.
9. Web read path: catalog, event page, revalidate route (+ spikes S1-S5).
10. Web mutations: auth pages, booking, checkout, my bookings, admin.
11. Docker, nginx, `web` shutdown wrapper, build stage.
12. e2e.
13. Autocannon run, build output, bundle report, README, walk through all 27 checks.
14. CI, then code + security review.

## 10. Spikes (inside phase 9, before relying on them)

- S1: after `revalidateTag('event:<id>', {expire:0})`, do both a build-prerendered page and an on-demand stored page show the new title? Fallback: also `revalidatePath`.
- S2: real 404 for unlisted ids with personal blocks in `<Suspense>`.
- S3: build stage with Postgres + Redis, and its build time.
- S4: `web` wrapper exits 0 on `SIGTERM` during a request.
- S5: nginx `proxy_cache` with streamed Suspense pages and the `RSC` header.

## 11. Acceptance checks -> where they land

| Checks | Covered in |
| --- | --- |
| 1, 2 | Phase 11: single command start, only nginx published |
| 3 | Phase 3: `env.ts` |
| 4, 5 | Phases 1 and 14 |
| 6, 7, 8, 10 | Phases 5 and 7 (+ api tests) |
| 9 | Phases 6, 8, 9: fast path, outbox, revalidate route |
| 11, 12 | Phase 9: `notFound()` before streaming, `generateStaticParams` |
| 13, 14 | Phases 6 and 13: oversell trigger, idempotency, autocannon |
| 15, 19, 20, 23 | Phases 10 and 11: optimistic provider, Suspense blocks, nginx bypass rules |
| 16, 17 | Phases 7 and 8: expiry job + SSE |
| 18 | Phase 10: version conflict form |
| 21, 22 | Phase 7: IP trust rule, login limit |
| 24 | Phase 13: bundle script |
| 25, 26 | Phases 3, 8, 11: shutdown everywhere, request id |
| 27 | Phase 13: README table check |

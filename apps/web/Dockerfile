# WHAT THIS FILE DOES
# Builds the image for the web app (Next.js). Two stages, like the others.
#
# The 30 nearest events are built into pages AT BUILD TIME, and that needs real data. So the kitchen
# (stage 1) starts a throwaway PostgreSQL, Redis and the api inside itself, builds the pages from them,
# and throws them away again; only the finished pages reach the final image. The throwaway passwords are
# made up on the spot inside one command and are not stored in any layer.
#
# Build it from the repository root:  docker build -f apps/web/Dockerfile .


# ---------- STAGE 1: the kitchen ----------
FROM node:22-alpine AS build

# postgresql + redis: temporary, only for building the pages. They are not in the final image.
RUN apk add --no-cache postgresql redis && npm install -g pnpm@12.6.0
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @app/web... --filter @app/api... --filter @app/db...

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/db packages/db
COPY apps/api apps/api
COPY apps/web apps/web
RUN pnpm --filter @app/db build && pnpm --filter @app/api build

# Start a temporary database, Redis and api; build the web app against them; stop them again.
RUN set -eu; \
    SECRET="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"; \
    mkdir -p /tmp/pg /run/postgresql; chown postgres:postgres /tmp/pg /run/postgresql; \
    su postgres -c "initdb -D /tmp/pg --auth=trust -U postgres" > /dev/null; \
    su postgres -c "pg_ctl -D /tmp/pg -o '-c listen_addresses=127.0.0.1' -w start" > /dev/null; \
    redis-server --daemonize yes --bind 127.0.0.1 --port 6379 > /dev/null; \
    export DATABASE_URL="postgres://postgres@127.0.0.1:5432/postgres" REDIS_URL="redis://127.0.0.1:6379" \
           INTERNAL_API_SECRET="$SECRET" SEED_ADMIN_PASSWORD="$SECRET" SEED_ALICE_PASSWORD="$SECRET" SEED_BOB_PASSWORD="$SECRET" \
           API_PORT=4000 API_URL="http://127.0.0.1:4000" LOG_LEVEL=warn; \
    node packages/db/dist/migrate.js; \
    (cd apps/api && node dist/main.js > /tmp/api.log 2>&1 &); \
    for i in $(seq 1 60); do wget -q -O /dev/null http://127.0.0.1:4000/ready && break; sleep 1; done; \
    wget -q -O /dev/null http://127.0.0.1:4000/ready || { echo "the temporary api did not start"; cat /tmp/api.log; exit 1; }; \
    pnpm --filter @app/web build; \
    su postgres -c "pg_ctl -D /tmp/pg -m fast stop" > /dev/null; \
    redis-cli shutdown nosave || true


# ---------- STAGE 2: the plate ----------
FROM node:22-alpine

ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

# The self-contained server, its static files, and the small wrapper that stops it politely.
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --chown=node:node apps/web/docker-entry.mjs ./docker-entry.mjs

# Run as an ordinary user, not as root.
USER node
EXPOSE 3000
CMD ["node", "docker-entry.mjs"]

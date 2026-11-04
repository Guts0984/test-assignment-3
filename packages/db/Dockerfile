# WHAT THIS FILE DOES
# Builds a small image whose only job is to set up the database: create the tables, add the
# demo data, then stop.
#
# It has TWO STAGES (the assignment asks for this). Think of a kitchen and a plate:
#   Stage 1 = the kitchen. Has all the tools. Turns our TypeScript code into plain JavaScript.
#   Stage 2 = the plate. A clean image with ONLY the finished result. This is what runs.
# Only stage 2 is kept. Stage 1 is thrown away after the build.
#
# Build it from the repository root:  docker build -f packages/db/Dockerfile .


# ---------- STAGE 1: the kitchen ----------
FROM node:22-alpine AS build

# pnpm is the tool this project uses to install packages.
RUN npm install -g pnpm@12.6.0

WORKDIR /repo

# Step 1: install the packages the database code needs.
# (pnpm checks the package list of every project folder against its lock file, so all are copied.)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile --filter @app/db...

# Step 2: copy our code and build it into one plain JavaScript file (dist/migrate.js).
COPY tsconfig.base.json ./
COPY packages/db packages/db
RUN pnpm --filter @app/db build

# Step 3: put the few packages the built file still needs when it runs into the folder /out.
RUN pnpm --filter @app/db deploy --legacy --prod /out


# ---------- STAGE 2: the plate ----------
FROM node:22-alpine

WORKDIR /app

# Take only the finished things from the kitchen.
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/packages/db/dist ./dist
COPY --from=build --chown=node:node /repo/packages/db/migrations ./migrations

# Run as an ordinary user, not as the all-powerful root user
USER node

# What happens when the container starts: create the tables, add demo data, stop.
CMD ["node", "dist/migrate.js"]

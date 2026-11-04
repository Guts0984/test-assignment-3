
FROM node:22-alpine AS build


RUN npm install -g pnpm@12.6.0

WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile --filter @app/api...

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/db packages/db
COPY apps/api apps/api
RUN pnpm --filter @app/api build


RUN pnpm --filter @app/api deploy --legacy --prod /out


# ---------- STAGE 2: the plate ----------
FROM node:22-alpine

# Tells Node and the libraries it is running for real (not in development): a bit faster.
ENV NODE_ENV=production

WORKDIR /app

# Take only the finished things from the kitchen.
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/apps/api/dist ./dist

# Run as an ordinary user, not as the all-powerful root user (the assignment asks for this).
USER node

EXPOSE 4000

# What happens when the container starts: run the api.
CMD ["node", "dist/main.js"]

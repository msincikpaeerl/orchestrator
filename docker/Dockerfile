# syntax=docker/dockerfile:1.27.0
# Orchestrator server image (09, section 7.1; ADR 0014). Build context: repository root.

FROM node:24.21.0-trixie-slim AS build
WORKDIR /repo

# Dependencies first, so this layer is cached until a package.json or the lock file changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/daemon/package.json apps/daemon/
COPY packages/protocol/package.json packages/protocol/
COPY packages/db/package.json packages/db/
COPY templates/package.json templates/
# pnpm at the version pinned by packageManager in package.json.
RUN npm install --global "pnpm@$(node -p "require('./package.json').packageManager.split('@')[1]")"
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY . .
RUN pnpm build
# The server with its workspace packages and production dependencies only.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm --filter @orchestrator/server deploy --prod /out

FROM node:24.21.0-trixie-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out ./
# The `orchestrator` command (09, section 7.4), for example `orchestrator reset-password`.
COPY <<'EOF' /usr/local/bin/orchestrator
#!/bin/sh
exec node /app/dist/cli.js "$@"
EOF
RUN chmod 755 /usr/local/bin/orchestrator
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]

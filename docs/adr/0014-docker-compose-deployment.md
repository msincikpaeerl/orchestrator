# 0014 — Deployment with Docker Compose

- Status: accepted
- Date: 2026-09-23

## Context

09, section 7: the server and PostgreSQL run as two containers on WSL, Unraid or a VPS, configured by environment variables. The daemon is never containerised.

## Decision

- `docker/Dockerfile` is multi-stage: it installs and builds the whole workspace, then `pnpm deploy` copies the server with its production dependencies only into a `node:24.21.0-trixie-slim` image (same Node.js as `.nvmrc`), run as the `node` user.
- `docker/compose.yml` (project `orchestrator`) runs `orchestrator` and `postgres`. PostgreSQL is only reachable inside the Compose network, with fixed credentials; its data is in the named volume `postgres-data`. The server waits for PostgreSQL to be healthy, applies migrations, and has its own health check on `/health`.
- Variables come from the shell or a `.env` file next to the compose file's project (see `docs/dev/setup.md`): `ORCHESTRATOR_SECRET_KEY` is required; `PUBLIC_URL`, `PORT` (published port) and `LOG_LEVEL` have defaults.
- `docker/compose.dev.yml` (project `orchestrator-dev`) runs PostgreSQL only, on `127.0.0.1:5432`.
- Base images are pinned by exact tag.

## Alternatives considered

- One container with PostgreSQL inside: harder upgrades and backups, against the image's single purpose.
- Kubernetes or Swarm: far beyond one user on one host.

## Consequences

- Updating Node.js means changing `.nvmrc`, `engines` and the Dockerfile tags together.
- The UI is added to the image in lot 0 step D, when it exists.

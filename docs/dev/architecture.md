# Architecture

The full description is in [09 — Architecture and Deployment](../specs/09-architecture-and-deployment.md). This page tracks what exists in the code today.

## Components

| Folder | Package | Role | State |
|---|---|---|---|
| `apps/server` | `@orchestrator/server` | Fastify server: API, realtime, daemon gateway, MCP backend, scheduler, GitHub integration, serves the UI. | config, migrations at start, `/health`, `/version` |
| `apps/web` | `@orchestrator/web` | React UI, built into static files served by the server. | placeholder |
| `apps/daemon` | `@orchestrator/daemon` | Runs on each machine: tmux and Claude Code sessions, hooks, MCP relay. | placeholder |
| `packages/protocol` | `@orchestrator/protocol` | Zod schemas shared by all apps. Holds `PROTOCOL_VERSION`. | `/health` and `/version` responses |
| `packages/db` | `@orchestrator/db` | Drizzle schema and SQL migrations, `runMigrations`, test databases (`@orchestrator/db/testing`). | `schema_info` table only |

## Dependencies between packages

```
apps/server  ──► packages/protocol, packages/db
apps/daemon  ──► packages/protocol
apps/web     ──► packages/protocol
```

Only the server's dependencies exist so far; the others are added with the code that needs them.

## Server start

`src/main.ts` reads the configuration (`src/config.ts`, Zod), creates the Pino logger, then `startServer` (`src/server.ts`) applies migrations and listens. Routes are declared in `buildApp` (`src/app.ts`), which tests call without a network port. `SIGTERM` closes the HTTP server, then the database pool.

## Deployment

`docker/Dockerfile`, `docker/compose.yml` and `docker/services.yml`: see [09, section 7](../specs/09-architecture-and-deployment.md#7-deployment) and ADR 0014.

## Decisions

Technical choices are recorded in [`docs/adr/`](../adr/).

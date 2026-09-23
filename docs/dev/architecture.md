# Architecture

The full description is in [09 — Architecture and Deployment](../specs/09-architecture-and-deployment.md). This page tracks what exists in the code today.

## Components

| Folder | Package | Role | State |
|---|---|---|---|
| `apps/server` | `@orchestrator/server` | Fastify server: API, realtime, daemon gateway, MCP backend, scheduler, GitHub integration, serves the UI. | config, migrations at start, `/health`, `/version`, owner account and sessions, GitHub token (API only), `orchestrator reset-password` |
| `apps/web` | `@orchestrator/web` | React UI, built into static files served by the server. | placeholder |
| `apps/daemon` | `@orchestrator/daemon` | Runs on each machine: tmux and Claude Code sessions, hooks, MCP relay. | placeholder |
| `packages/protocol` | `@orchestrator/protocol` | Zod schemas shared by all apps. Holds `PROTOCOL_VERSION`. | API requests and responses, event types, GitHub permission list |
| `packages/db` | `@orchestrator/db` | Drizzle schema and SQL migrations, `runMigrations`, test databases (`@orchestrator/db/testing`). | `owner`, `sessions`, `login_failures`, `secrets`, `github_connection`, `events` |

## Dependencies between packages

```
apps/server  ──► packages/protocol, packages/db
apps/daemon  ──► packages/protocol
apps/web     ──► packages/protocol
```

Only the server's dependencies exist so far; the others are added with the code that needs them.

## Server start

`src/main.ts` reads the configuration (`src/config.ts`, Zod), creates the Pino logger, then `startServer` (`src/server.ts`) applies migrations and listens. Routes are declared in `buildApp` (`src/app.ts`), which tests call without a network port. `SIGTERM` closes the HTTP server, then the database pool.

## Server modules

| Path | Role |
|---|---|
| `src/auth/` | Owner creation, login with throttling, logout, sessions (ADR 0015). `requireSession` guards every API route except `/api/setup` and login. |
| `src/github/` | GitHub client, token check by probing (ADR 0017), connection state and "Needs you" problems, routes. Every request made with the saved token must use `storedTokenClient`, which records refusals. |
| `src/secrets.ts` | Encrypted secrets (ADR 0016). |
| `src/events.ts` | `recordEvent`: every state change writes an event, in the same transaction. |
| `src/settings.ts` | Settings with their defaults (04, section 8). Not editable yet. |
| `src/http.ts` | Input validation with the protocol schemas and the error format (`ApiError`). |
| `src/cli.ts` | The `orchestrator` command of the image: `reset-password` (`src/reset-password.ts`). |

## API

| Route | Session | Purpose |
|---|---|---|
| `GET /api/setup` | no | Which wizard steps are done. |
| `POST /api/setup/owner` | no | Wizard step 1; refused once an owner exists. Logs in. |
| `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/session` | login: no | Session cookie. |
| `GET /api/github` | yes | Connection status, permission results and problems. Never the token. |
| `POST /api/github/token/inspect` | yes | Validity, account and suggested expiry date of a pasted token. |
| `PUT /api/github/token` | yes | Save (or replace) the token with its expiry date, then check it. |
| `POST /api/github/token/check` | yes | Check the saved token again. |

Request and response schemas are in `packages/protocol/src/api/`.

## Deployment

`docker/Dockerfile`, `docker/compose.yml` and `docker/services.yml`: see [09, section 7](../specs/09-architecture-and-deployment.md#7-deployment) and ADR 0014.

## Decisions

Technical choices are recorded in [`docs/adr/`](../adr/).

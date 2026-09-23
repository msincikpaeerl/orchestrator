# Architecture

The full description is in [09 — Architecture and Deployment](../specs/09-architecture-and-deployment.md). This page tracks what exists in the code today.

## Components

| Folder | Package | Role | State |
|---|---|---|---|
| `apps/server` | `@orchestrator/server` | Fastify server: API, realtime, daemon gateway, MCP backend, scheduler, GitHub integration, serves the UI. | config, migrations at start, `/health`, `/version`, owner account and sessions, GitHub token, `orchestrator reset-password`, serves the UI |
| `apps/web` | `@orchestrator/web` | React UI, built into static files served by the server. | setup wizard, login, app shell, Needs you (GitHub problems), Settings > GitHub connection, Help |
| `apps/daemon` | `@orchestrator/daemon` | Runs on each machine: tmux and Claude Code sessions, hooks, MCP relay. | placeholder |
| `packages/protocol` | `@orchestrator/protocol` | Zod schemas shared by all apps. Holds `PROTOCOL_VERSION`. | API requests and responses, event types, GitHub permission list |
| `packages/db` | `@orchestrator/db` | Drizzle schema and SQL migrations, `runMigrations`, test databases (`@orchestrator/db/testing`). | `owner`, `sessions`, `login_failures`, `secrets`, `github_connection`, `events` |

## Dependencies between packages

```
apps/server  ──► packages/protocol, packages/db, apps/web (its built dist/)
apps/daemon  ──► packages/protocol
apps/web     ──► packages/protocol
```

The daemon's dependency is added with the code that needs it.

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
| `src/web.ts` | Serves the built UI, and its `index.html` for screen addresses; unknown API addresses answer `not_found` (ADR 0018). |

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

Request and response schemas are in `packages/protocol/src/api/`. Any other `GET` address outside `/api`, `/health`, `/version` and `/assets` returns the UI.

## UI

| Path in `apps/web/src` | Role |
|---|---|
| `main.tsx`, `app.tsx` | Entry point; routes (ADR 0019), and the redirections to the wizard or the login page. |
| `api.ts`, `queries.ts` | API calls validated with the protocol schemas; TanStack Query hooks for setup state, session and GitHub status. |
| `pages/` | One file per screen: setup wizard and Done page, login, Needs you, Settings, Help, "Coming in a later version". |
| `components/` | Shell (navigation, "Menu" on a phone) and shared form elements. |
| `github/` | Token instructions and form, permission results, wording of GitHub problems. |
| `help/` | `docs/user/` bundled at build time, page order, links and search (ADR 0020). |

Help is readable without logging in, so the login page and the wizard can link to it.

## Deployment

`docker/Dockerfile`, `docker/compose.yml` and `docker/services.yml`: see [09, section 7](../specs/09-architecture-and-deployment.md#7-deployment) and ADR 0014.

## Decisions

Technical choices are recorded in [`docs/adr/`](../adr/).

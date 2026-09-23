# Architecture

The full description is in [09 — Architecture and Deployment](../specs/09-architecture-and-deployment.md). This page tracks what exists in the code today.

## Components

| Folder | Package | Role | State |
|---|---|---|---|
| `apps/server` | `@orchestrator/server` | Fastify server: API, realtime, daemon gateway, MCP backend, scheduler, GitHub integration, serves the UI. | config, migrations at start, `/health`, `/version`, owner account and sessions, GitHub token, projects API with repository setup, tickets API, "Needs you" API, UI settings, `orchestrator reset-password`, serves the UI |
| `apps/web` | `@orchestrator/web` | React UI, built into static files served by the server. | setup wizard, login, app shell, Needs you (GitHub problems), Settings > GitHub connection, Help |
| `apps/daemon` | `@orchestrator/daemon` | Runs on each machine: tmux and Claude Code sessions, hooks, MCP relay. | placeholder |
| `packages/protocol` | `@orchestrator/protocol` | Zod schemas shared by all apps. Holds `PROTOCOL_VERSION`. | API requests and responses, event types, GitHub permission list, projects, tickets and comments, "Needs you" items |
| `packages/db` | `@orchestrator/db` | Drizzle schema and SQL migrations, `runMigrations`, test databases (`@orchestrator/db/testing`). | `owner`, `sessions`, `login_failures`, `secrets`, `github_connection`, `events`, `projects`, `tickets`, `ticket_dependencies`, `comments` |
| `templates` | `@orchestrator/templates` | Files the server writes to GitHub, bundled in the image through the server's dependency (ADR 0023). | `project-skeleton/`: the common skeleton of a new repository (08, section 3.1) |

## Dependencies between packages

```
apps/server  ──► packages/protocol, packages/db, apps/web (its built dist/), templates
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
| `src/github/` | GitHub client, token check by probing (ADR 0022), connection state and "Needs you" problems, routes. Every request made with the saved token must use `storedTokenClient`, which records refusals. |
| `src/github/repositories.ts` | Repository operations of project creation (ADR 0023): list the owner's repositories, find one by name, create one, apply the skeleton commit, apply the branch protection ruleset (`applied`, `not_available`, `failed`), find missing harness elements. Used by the projects module. |
| `src/github/skeleton.ts` | Reads `templates/project-skeleton` and fills in its placeholders. |
| `src/projects/` | Projects: routes (`routes.ts`), the API view of a row (`model.ts`) and the repository setup (`setup.ts`). |
| `src/projects/setup.ts` | `ProjectSetupRunner` runs a project's setup in the background after it is saved: `repository`, `skeleton`, `branch_protection` for a new repository, `harness` for a linked one. Each step records its result and an event before the next starts, so **Try again** resumes from the failed step. A failure stores the reason written for the owner. The server waits for running setups before closing; at start, `failInterruptedSetups` turns a setup left `in_progress` into `failed` ("interrupted by a restart"). If the answer to the repository creation was lost, trying again reuses the repository found under that name only when GitHub created it after the request (`repo_requested_at`, with the `githubClockToleranceSeconds` tolerance) and it holds at most GitHub's first commit; otherwise "Repository name already taken" (ADR 0023). |
| `src/tickets/` | Tickets: routes (`routes.ts`), the API view of rows and the board order (`model.ts`), and the transition module (`transitions.ts`). Every change runs in one transaction that first locks the project's row (`FOR NO KEY UPDATE`) and refuses an archived or not ready project: ticket numbers (`projects.last_ticket_number`, never decremented), dependency cycle checks and archiving are decided one request at a time per project. "Blocked" is computed when read (a dependency not `done`). |
| `src/tickets/transitions.ts` | The only code that writes `tickets.status` (04, section 2): owner creation in `todo`, **Cancel**, **Mark as done manually** (its mandatory comment written as a `status_change` comment) and **Reopen**; any other action from a state is refused with an explanation. The status, its `ticket.status_changed` event and the comment are written in the caller's transaction. Edits and dependency changes are allowed in `EDITABLE_STATUSES` (`proposed`, `todo`). |
| `src/needs-you.ts` | "Needs you" items other than GitHub problems: failed setups of active projects. |
| `src/secrets.ts` | Encrypted secrets (ADR 0016). |
| `src/events.ts` | `recordEvent`: every state change writes an event, in the same transaction; ticket events take the time of the change so the timeline keeps its order. |
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
| `GET /api/projects` | yes | Projects; archived ones only with `?archived=true`. |
| `GET /api/projects/availability` | yes | `?key=` and `?repositoryName=`: `free`, `taken` or `invalid`. |
| `GET /api/projects/linkable-repositories` | yes | The owner's repositories that are not archived and not linked yet. |
| `POST /api/projects` | yes | Create with a new repository or by linking one; the setup then runs in the background. |
| `GET /api/projects/:key`, `PATCH /api/projects/:key` | yes | Detail; edit the name and description (not on an archived project). |
| `POST /api/projects/:key/setup/retry` | yes | **Try again** a failed setup, from the failed step. |
| `POST /api/projects/:key/harness/check` | yes | **Check again** the harness elements of a linked repository. |
| `POST /api/projects/:key/archive`, `.../unarchive` | yes | Archive (refused while the setup runs) or unarchive; no request to GitHub. |
| `GET /api/projects/:key/tickets`, `POST ...` | yes | Board data (every ticket in board order with its blocked flag); create a ticket in `todo`, with optional dependencies. |
| `GET /api/projects/:key/tickets/:number`, `PATCH ...` | yes | Detail with "Blocked by", "Blocks" and the timeline (comments and status changes); edit in `proposed` or `todo`. |
| `POST /api/projects/:key/tickets/:number/dependencies`, `DELETE .../dependencies/:blockedBy` | yes | Add (same project, not itself, no cycle: the refusal names it) or remove a dependency, while the waiting ticket is `proposed` or `todo`. |
| `POST /api/projects/:key/tickets/:number/comments` | yes | Owner note, on any ticket of an active, ready project. |
| `POST /api/projects/:key/tickets/:number/cancel`, `.../mark-done`, `.../reopen` | yes | Owner status changes (04, section 2); `mark-done` needs `{ comment }`. |
| `GET /api/needs-you` | yes | "Needs you" items besides GitHub problems, oldest first. |
| `GET /api/ui-settings` | yes | Settings the screens use: `projectSetupPollSeconds`. |

Request and response schemas are in `packages/protocol/src/api/`. Any other `GET` address outside `/api`, `/health`, `/version` and `/assets` returns the UI.

## UI

| Path in `apps/web/src` | Role |
|---|---|
| `main.tsx`, `app.tsx` | Entry point; routes (ADR 0019), and the redirections to the wizard or the login page. |
| `api.ts`, `queries.ts` | API calls validated with the protocol schemas; TanStack Query hooks for setup state, session, GitHub status, "Needs you", UI settings, projects and tickets. Screens refresh after each action and on window focus; the project page polls while its setup is `in_progress` (02, section 1). |
| `pages/` | One file per screen: setup wizard and Done page, login, Needs you, Projects (list, new project, project page and settings), tickets (page, new and edit form), Settings, Help, "Coming in a later version". |
| `components/` | Shell (navigation, "Menu" on a phone), shared form elements with field errors, confirmation dialog, `UntrustedMarkdown` for every text written by the owner or agents (ADR 0024). |
| `refusals.ts` | Plain-words text of every API refusal code (a unit test enumerates `ApiErrorCode`), with the fields over their limit and the tickets of a dependency cycle. |
| `projects/` | Project wording: labels, the form field of each refusal, key suggestion, archive and unarchive with confirmation. |
| `tickets/` | Board (columns side by side, stacked on a phone), ticket wording, blocked explanation. |
| `github/` | Token instructions and form, permission results, wording of GitHub problems. |
| `help/` | `docs/user/` bundled at build time, page order, links and search (ADR 0020). |

Help is readable without logging in, so the login page and the wizard can link to it.

## Deployment

`docker/Dockerfile`, `docker/compose.yml` and `docker/services.yml`: see [09, section 7](../specs/09-architecture-and-deployment.md#7-deployment) and ADR 0014.

## Decisions

Technical choices are recorded in [`docs/adr/`](../adr/).

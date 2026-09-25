# Architecture

The full description is in [09 — Architecture and Deployment](../specs/09-architecture-and-deployment.md). This page tracks what exists in the code today.

## Components

| Folder | Package | Role | State |
|---|---|---|---|
| `apps/server` | `@orchestrator/server` | Fastify server: API, realtime, daemon gateway, MCP backend, scheduler, GitHub integration, serves the UI. | config, migrations at start, `/health`, `/version`, owner account and sessions, GitHub token, projects API with repository setup, tickets API, "Needs you" API, UI settings, settings (Settings > Limits and project overrides), `orchestrator reset-password`, serves the UI |
| `apps/web` | `@orchestrator/web` | React UI, built into static files served by the server. | setup wizard, login, app shell, Needs you, projects, tickets, Settings > GitHub connection and Limits, project overrides, Help |
| `apps/daemon` | `@orchestrator/daemon` | Runs on each machine: tmux and Claude Code sessions, hooks, MCP relay. | placeholder |
| `packages/protocol` | `@orchestrator/protocol` | Zod schemas shared by all apps. Holds `PROTOCOL_VERSION`. | API requests and responses, event types and the payload schema of each (`EventPayloads`), GitHub permission list, projects, tickets and comments, "Needs you" items; daemon messages (`src/daemon/`: `DaemonMessage` and `ServerMessage`, one schema per message type of 05 section 3.3); MCP tools (`src/mcp/`: `MCP_TOOLS` with each tool's description, input and output, and `McpError`); text ceilings derived from the settings' ranges (`text-limits.ts`) |
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

`src/main.ts` reads the configuration (`src/config.ts`, Zod), creates the Pino logger, then `startServer` (`src/server.ts`) applies migrations, fails project setups interrupted by a restart, marks machines left `online` offline (no daemon is connected yet), and listens. Routes are declared in `buildApp` (`src/app.ts`), which tests call without a network port. `SIGTERM` closes the HTTP server, then the database pool.

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
| `src/machines/` | Claude accounts (`accounts.ts`), machines and enrollment (`routes.ts`), the API view of a row, machine state label and capability sources (`model.ts`), enrollment codes and machine tokens, stored as SHA-256 hashes only (`credentials.ts`). A code is marked used in the transaction that sets the token, under the machine's row lock, so it enrolls one daemon only; wrong codes are throttled per address with the login throttle (`src/auth/throttle.ts`, key `enrollment:<address>`). |
| `src/machines/gateway.ts` | The daemon gateway (05, section 3.2; ADR 0025): the `/daemon` WebSocket, authenticated by the machine token before it opens; `hello`/`welcome` with the protocol check; the machine's reported versions, capabilities and `doctor` results; the silence timer (no message for "Machine offline after", never below twice the connection's heartbeat interval); offline on close; a newer connection replacing an older one. Work on one machine's status runs in order (a promise chain per machine), so a close and a new `hello` never cross. Tests shorten its second (`daemonSecondMs` of `buildApp`). |
| `src/needs-you.ts` | "Needs you" items other than GitHub problems: setup still to do (no Claude account, no enrolled machine), failed setups of active projects, and machines with an incompatible daemon, an unsupported Claude Code or a `doctor` error. |
| `src/secrets.ts` | Encrypted secrets (ADR 0016). |
| `src/events.ts` | `recordEvent`: every state change writes an event, in the same transaction; ticket events take the time of the change so the timeline keeps its order. `projectId` is the project the event concerns (`projectEntity` and `ticketEntity` give it; a project's setting override too); events about the owner, sessions, the GitHub connection and global settings have none. |
| `src/event-log.ts` | `GET /api/events` (Activity > Event log): newest first by (`created_at`, `id`), filters, and a cursor of the last event's time (in microseconds, as stored) and id, so events written between two pages shift nothing. The index `events_project_time` (`project_id`, `created_at`, `id`) serves the project filter and the project list's last activity, `events_entity_time` the ticket and kind filters, `events_time` the rest. Each payload is parsed with its type's schema (other fields are dropped) and GitHub or Anthropic credentials are masked, also in quoted comments. |
| `src/settings/` | Settings (04, section 8). `resolveSettings` in `store.ts` is the only way code reads a setting: the project's override, then the global value, then the default of `SETTINGS` (`packages/protocol/src/api/settings.ts`, which describes each setting once: label, description, unit, range, default, per project, version that first uses it). Values are read when needed, so a change applies without a restart. Stored in `setting_values` (null `project_id` for the global value); a setting without a row uses its default. `changeSetting` is the only way to change one: it runs one change at a time (table lock, reads not blocked) and refuses a change or reset that breaks a pair of `SETTING_ORDER` (07, section 8): never above, at least a multiple (`factor`), or strictly below (`strict`). `routes.ts`: Settings > Limits and project overrides; every change and reset writes `setting.changed` or `setting.reset`. |
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
| `GET /api/projects` | yes | Projects with their ticket counts and last activity (time of their latest event); archived ones only with `?archived=true`. |
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
| `GET /api/events` | yes | Event log, newest first, `EVENT_LOG_PAGE_SIZE` events a page: filters `project`, `ticket` (a number, with `project`), `entity`, `type`, `from` (included), `to` (excluded); `before` is the `next` cursor of the previous page. Each event comes with its project key, ticket number and, for comments, the comment shortened. |
| `GET /api/needs-you` | yes | "Needs you" items besides GitHub problems: setup still to do first, then the others oldest first. |
| `GET /api/accounts`, `POST ...`, `PATCH /api/accounts/:id` | yes | Claude accounts: list, create, edit (label, plan, maximum concurrent runs). |
| `GET /api/machines`, `POST ...`, `GET /api/machines/:id` | yes | Machines; create one with its account, answered with its one-time enrollment code and the install and enroll commands. |
| `POST /api/machines/:id/enrollment-code` | yes | **New enrollment code** for a machine waiting for enrollment or revoked; a revoked machine goes back to waiting. |
| `POST /api/machines/:id/disable`, `.../enable`, `.../revoke` | yes | Disable (no new runs) and enable; revoke (disconnects the daemon, the token never works again). |
| `PUT /api/machines/:id/capabilities` | yes | The tags the machine should have; the server keeps each tag's source (detected, added, removed). |
| `POST /daemon/enroll` | no | `orchestrator-daemon enroll`: a one-time code for the machine token (05, section 3.1). Throttled per address. |
| `GET /daemon` (WebSocket) | machine token | The daemon connection (05, section 3.2): `Authorization: Bearer <token>`, then `hello`. |
| `GET /api/ui-settings` | yes | Settings the screens use: `projectSetupPollSeconds`. |
| `GET /api/settings`, `PUT /api/settings/:name`, `DELETE /api/settings/:name` | yes | Settings > Limits: every setting's global value; change one (`{ value }`, checked against its range); **Reset to default**. |
| `GET /api/projects/:key/settings`, `PUT .../settings/:name`, `DELETE .../settings/:name` | yes | The settings a project can override, with the global values; override one; remove the override. Changes refused on an archived project and for global-only settings. |

Request and response schemas are in `packages/protocol/src/api/`; the daemon's are in `packages/protocol/src/daemon/`. Any other `GET` address outside `/api`, `/health`, `/version` and `/assets` returns the UI.

## UI

| Path in `apps/web/src` | Role |
|---|---|
| `main.tsx`, `app.tsx` | Entry point; routes (ADR 0019), and the redirections to the wizard or the login page. |
| `api.ts`, `queries.ts` | API calls validated with the protocol schemas; TanStack Query hooks for setup state, session, GitHub status, "Needs you", UI settings, settings, projects and tickets. Screens refresh after each action and on window focus; the project page polls while its setup is `in_progress` (02, section 1). |
| `pages/` | One file per screen: setup wizard and Done page, login, Needs you, Projects (list, new project, project page and settings), tickets (page, new and edit form), Settings and Settings > Limits, Activity (event log), Help, "Coming in a later version". |
| `components/` | Shell (navigation, "Menu" on a phone), shared form elements with field errors, confirmation dialog, `UntrustedMarkdown` for every text written by the owner or agents (ADR 0024). |
| `activity/` | Event log wording: the plain-words text of every event type (a unit test enumerates `EventType`), built from pieces of text and links; quoted titles, names and comments are shortened plain text linking to the page with the full text. |
| `refusals.ts` | Plain-words text of every API refusal code (a unit test enumerates `ApiErrorCode`), with the fields over their limit, the tickets of a dependency cycle, the two settings of an order and the setting (with its current value) behind a refusal. |
| `projects/` | Project wording: labels, the form field of each refusal, key suggestion, archive and unarchive with confirmation. |
| `tickets/` | Board (columns side by side, stacked on a phone), ticket wording, blocked explanation. |
| `settings/` | One setting with **Save** and **Reset to default** (a section named after the setting), project overrides, range check and wording. A unit test checks `docs/user/settings.md` lists every setting with its default and range. |
| `github/` | Token instructions and form, permission results, wording of GitHub problems. |
| `help/` | `docs/user/` bundled at build time, page order, links and search (ADR 0020). |

Help is readable without logging in, so the login page and the wizard can link to it.

## Deployment

`docker/Dockerfile`, `docker/compose.yml` and `docker/services.yml`: see [09, section 7](../specs/09-architecture-and-deployment.md#7-deployment) and ADR 0014.

## Decisions

Technical choices are recorded in [`docs/adr/`](../adr/).

# CLAUDE.md — Orchestrator

Instructions for Claude Code working on this repository. Keep this file under 150 lines.
Details belong in `docs/`; this file only points to them.

## What this project is

A self-hosted tool that turns plain-language requests into web apps, websites and Android apps by coordinating AI agents running in Claude Code. Two parts:

- **Server** (Docker): web UI, API, scheduler, MCP backend, GitHub integration, PostgreSQL.
- **Daemon** (host, Linux or WSL): drives interactive Claude Code sessions in tmux on each machine.

The owner does not read code. Every user-facing change must be usable from the UI and the user documentation alone.

## Current state

Lots 0 and 1 of `docs/specs/10-delivery-plan.md` are done (version 0.1.0, `docs/dev/lot-0-plan.md`; version 0.2.0, `docs/dev/lot-1-plan.md`). Lot 2 (version 0.3.0) is in progress: follow `docs/dev/lot-2-plan.md` and `docs/dev/working-rules.md`, one step at a time. Never start a real Claude Code session (working rule 10): tests use the fake `claude` executable. Commands marked *(later)* are not implemented yet. Update this file when the setup changes.

## Read before working

1. The ticket or task you were given, and `docs/dev/working-rules.md`.
2. The spec sections it refers to, in `docs/specs/` (start with `README.md` there).
3. The ADRs in `docs/adr/` related to the area you touch.

The specs are the source of truth. If the code must differ from a spec, update the spec in the same change and say why.

## Commands

| Task | Command |
|---|---|
| Install | `pnpm install` |
| Start database | `docker compose -f docker/compose.dev.yml up -d postgres` |
| Run server and UI in dev (UI on port 5173) | `pnpm dev` |
| Run daemon in dev (a command: `start`, `doctor`, ...) | `pnpm --filter @orchestrator/daemon dev <command>` |
| Unit and integration tests | `pnpm test` |
| End-to-end tests (Playwright Docker image, desktop and phone) | `pnpm test:e2e` |
| Lint and format check | `pnpm lint` (fix formatting: `pnpm format`) |
| Type check | `pnpm typecheck` |
| Documentation link check | `pnpm docs:links` |
| Build | `pnpm build` |
| Everything CI runs | `pnpm verify` then `pnpm test:e2e` (never `pnpm ci`: built-in pnpm command) |
| Reset the owner password (dev) | `pnpm --filter server orchestrator reset-password` |
| Database migration (new) | `pnpm --filter db migrate:generate` |
| Full stack in Docker | `docker compose -f docker/compose.yml up --build` |

Run `pnpm verify` and `pnpm test:e2e` before considering any task finished; both need the database started. Requires Node.js 24 (`.nvmrc`), Docker, and Git and tmux on the host (the daemon's tests); setup details in `docs/dev/setup.md`.

## Repository map

```
apps/server/     Fastify: API, SSE realtime, daemon gateway, MCP backend, scheduler, GitHub integration
apps/web/        React UI (Vite, TanStack Query, Tailwind)
apps/daemon/     Daemon, tmux runner, hooks endpoint, MCP relay
packages/protocol/  Zod schemas shared by all apps: daemon messages, MCP tools, API types
packages/db/     Drizzle schema and SQL migrations
agents/          Default agent instructions and run message templates
templates/       Files written to GitHub: project-skeleton/ for new repositories (ADR 0023)
docs/specs/      Specifications (00 to 10)
docs/user/       User documentation, shown in the app's Help section
docs/dev/        Developer documentation (architecture, setup, testing)
docs/adr/        Architecture Decision Records
tools/spike/     Claude Code behaviour spike (see 05-daemon.md, section 9)
docker/          Dockerfile and compose files
```

## Conventions

- TypeScript strict mode everywhere. No `any` without a comment explaining why.
- Every message between server, daemon and UI, and every MCP tool input and output, is defined once as a Zod schema in `packages/protocol`. Never duplicate these types in an app.
- Validate every external input (API, WebSocket, MCP, GitHub responses) with its schema.
- Ticket transitions and DoD checks live in the server only (`docs/specs/04-ticket-lifecycle.md`). The daemon reports facts; it never decides ticket state.
- The daemon never parses the terminal display. State comes from hooks, transcripts and MCP calls (`docs/specs/05-daemon.md`).
- Every limit and timeout is a setting with a default, never a hard-coded constant (`04`, section 8).
- Every state change writes an event (`01`, section 3.10).
- Logs: Pino, structured, with run id, ticket number and machine when relevant.
- Names: files in kebab-case, types in PascalCase, functions and variables in camelCase.
- All text (UI, docs, comments, commit messages) in English.
- Markdown is not formatted by Prettier: keep tables unpadded (`| a | b |`) to save context (ADR 0007).

## Tests

- New behaviour needs tests; a bug fix needs a regression test that fails before the fix.
- Unit tests next to the code (`*.test.ts`), integration tests in `apps/*/test/` and `packages/*/test/`, end-to-end tests in `apps/web/e2e/` (`*.e2e.ts`, run on desktop and phone viewports; browsers come from the Playwright image, never from the home folder).
- Integration tests use a real PostgreSQL (the dev compose database), never mocks of the database: one throw-away database per test file (`createTestDatabase` from `@orchestrator/db/testing`).
- The daemon's tmux and Claude Code layer is tested against a fake `claude` executable that emits hook calls and transcript lines; no real Claude Code in CI.
- Details: `docs/dev/testing.md`.

## Documentation

- A user-visible change updates `docs/user/` in the same change, written for someone who never reads code, organised by tasks.
- A setup or command change updates this file and `docs/dev/setup.md`.
- A significant technical choice (framework, library, protocol, storage, deployment) gets an ADR: copy `docs/adr/0000-template.md`, next number, status `accepted`.
- Add a `CHANGELOG.md` entry for user-visible changes.

## Git

- Conventional Commits: `feat(scheduler): resume paused runs first`. Reference the ticket number when there is one.
- Small commits with one purpose each.
- Work on a branch (`lot<N>/<step letter>-<short-name>` during lot N) created from `main`. Never commit to `main` directly and never push: the owner pushes, opens the pull request and merges.
- At the end of every step, give the owner a pull request title and description ready to paste, in one code block (`docs/dev/working-rules.md`, rule 12).
- Never commit secrets. Environment variables are listed in `.env.example`.

## Never

- Never install software or change anything outside this repository (no global installs, no files in the home folder, no PATH or shell changes). Only exception: Docker images declared in the repo's own files, pinned to an exact version. If a tool is missing, stop and say what to install.
- Never use `--dangerously-skip-permissions` in daemon code.
- Never send Claude credentials or the GitHub token to agents, the browser or logs.
- Never let an agent-facing path push to GitHub; only the daemon pushes, and only ticket branches.
- Never weaken a test or delete it to make CI pass. Fix the code or explain in the change why the test was wrong.
- Never add a dependency without a reason in the commit message; a major dependency needs an ADR.

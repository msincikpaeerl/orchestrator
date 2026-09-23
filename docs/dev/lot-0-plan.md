# Lot 0 — Implementation plan

> Status: done 2026-09-23 (version 0.1.0)
> Scope: "Lot 0 — Foundations" in [10 — Delivery Plan](../specs/10-delivery-plan.md). The spike is done ([ADR 0002](../adr/0002-claude-code-interactive-runner.md)).
> **Lot 0 is done when** the owner can start the stack on WSL, create the account, connect GitHub and read the getting started guide in the application.

## Working rules

Every session working on lot 0 follows these rules.

1. **Read first.** Read `CLAUDE.md` and this plan before working. Implement **only the next unchecked step**, nothing from later steps.
2. **Current, pinned versions.** Use the current stable version of every tool and library. Check it with `npm view <package> version` (or the official release index for Node.js and Docker images) instead of relying on memory, and pin it: exact versions in `package.json`, lock file committed, image tags pinned in Dockerfiles, compose files and the CI workflow, and CI runners pinned to an OS version (`ubuntu-24.04`, not `ubuntu-latest`).
3. **One ADR per choice.** Every technical choice from [09, section 3](../specs/09-architecture-and-deployment.md#3-technology-choices) gets its own short ADR (next number, copied from `docs/adr/0000-template.md`, status `accepted`) **in the step that introduces it**. The same applies to any other significant choice made along the way (library, test tool, encryption scheme).
4. **Do not invent.** If a spec is wrong, incomplete or contradicts another, stop and ask the owner. If a spec is changed, say so in the summary.
5. **No speculative code.** No feature code beyond what the step needs. Placeholders for later lots stay empty.
6. **Definition of done for a step:**
   - `pnpm verify` passes locally;
   - `docs/dev/` and `CLAUDE.md` are up to date (CLAUDE.md stays under 150 lines);
   - user-facing changes are documented in `docs/user/` and have a `CHANGELOG.md` entry;
   - the step is checked off in this plan;
   - the work is committed on the step's branch, ready for a pull request.
7. **Git.** From step B on, work on a branch named `lot0/<step letter>-<short-name>` (for example `lot0/b-server-db`) created from `main`. Commit with Conventional Commits, small commits with one purpose each. **Never commit to `main` directly and never push.** The owner pushes the branch, opens the pull request, checks CI and merges.
8. **Nothing outside the repository.** Never install software or change anything outside this repository: no global installs, no files in the owner's home folder, no PATH or shell changes. The only exception: Docker may pull images declared in the repository's own files (Dockerfiles, compose files, CI workflow, documented commands), pinned to an exact version. If a tool or version is missing, stop and tell the owner what to install.
9. **Summary.** End the session with a short summary: what was done, what the owner should check, what comes next, and that the branch is ready for a pull request.
10. **Pull request text.** At the end of every step, give the owner a pull request title and description ready to paste, both in one Markdown code block:
    - title in Conventional Commits style, for example `feat(auth): owner account and login`;
    - description following `.github/pull_request_template.md`, fully filled in: a summary written for the owner (what changes for the user), the ticket or "none", the acceptance criteria as checked items (the step's "Done when"), the tests added and how they were run, and the documentation checklist with each box checked or marked "not needed" with the reason.

## Steps

### [x] A. Monorepo, tooling and CI

- pnpm workspaces with the structure of 09, section 2: `apps/server`, `apps/web`, `apps/daemon`, `packages/protocol`, `packages/db`. Each is a minimal placeholder that builds and has one passing test.
- Shared strict `tsconfig` base, ESLint (flat config), Prettier, Vitest (workspace config).
- Root scripts matching the CLAUDE.md commands table; `pnpm verify` runs everything CI runs (not `pnpm ci`, which is a built-in pnpm command). Scripts belonging to later steps (`test:e2e`, database, docker) print which step adds them.
- Node.js LTS pinned (`.nvmrc`, `engines`), pnpm pinned (`packageManager`).
- Documentation link check (08, section 4) over `docs/` and the root Markdown files.
- GitHub Actions `ci.yml`: on pull requests and pushes to `main`, pnpm cache, runs `pnpm verify`, `pnpm audit --audit-level critical`.
- Harness files still missing from 08, section 2: `README.md`, `CHANGELOG.md`, `.github/pull_request_template.md`, `docs/dev/architecture.md` (short), `.gitignore`, `.editorconfig`, `.env.example` (variables of 09, section 7.1).
- ADRs: TypeScript (0003), Node.js LTS (0004), pnpm workspaces (0005), Vitest (0006), ESLint + Prettier + link check (0007), GitHub Actions (0008).
- `docs/dev/setup.md` and `docs/dev/testing.md` written; CLAUDE.md commands corrected.

**Done when** a fresh clone runs `pnpm install` then `pnpm verify` successfully, the workflow file is valid, and the ADRs are in `docs/adr/`.

### [x] B. Database, server skeleton and Docker Compose

- `packages/db`: Drizzle schema with a first migration (a `settings` or `schema_info` table only if needed to prove migrations; no lot 1 tables), `migrate:generate` and a programmatic migrate function.
- `apps/server`: Fastify with Pino logging, config read and validated with Zod from environment variables (09, section 7.1), `GET /health` (checks the database) and `GET /version` (server and protocol versions from `packages/protocol`), migrations applied at start.
- `docker/compose.dev.yml` (PostgreSQL for development and integration tests), `docker/Dockerfile` (multi-stage, server with the built UI), `docker/compose.yml` (orchestrator + postgres with a named volume and health checks).
- Integration tests against the real development database; CI gains a PostgreSQL service.
- ADRs: Fastify, PostgreSQL, Drizzle ORM with SQL migrations, Zod, Pino, Docker Compose deployment.

**Done when** `docker compose -f docker/compose.yml up --build` starts both containers, `/health` returns OK, `/version` returns the versions, migrations run at start, and integration tests pass in CI.

### [x] C. Owner account, login, password reset, setup wizard steps 1 and 2 (API)

- **First:** verify the token permission list of 02, section 3.1 against the current GitHub documentation for fine-grained personal access tokens, and report any difference to the owner before implementing. *Done 2026-09-23; decisions below.*
- `PUBLIC_URL` is optional: the server derives it from `PORT` (`http://localhost:<PORT>`).
- Tables: owner and sessions (01, section 3.11), encrypted secrets, events (only the event types this step emits, 01 section 3.10).
- API: setup state, create owner (only while none exists; password of at least 12 characters), login, logout, current session; session cookie HTTP-only, SameSite strict (09, section 5); Argon2 password hashing.
- `orchestrator reset-password` command in the server image (09, section 7.4): interactive prompt, same password rules, revokes all sessions, writes an event.
- GitHub token: save, check against the GitHub API (identity, permissions of 02 sections 3.1 and 3.2), report each permission as OK, Missing or Could not verify, never creating or changing anything on GitHub; expiry date entered by the owner (or "No expiry date"), pre-filled from GitHub's header only when plausible; stored encrypted with `ORCHESTRATOR_SECRET_KEY`; never returned to the browser after saving and never logged.
- GitHub refusals during use (token invalid, permission missing) are recorded for "Needs you" (02, section 4); the API exposes the token's problems and the pre-filled "Create the token on GitHub" link.
- Request and response schemas in `packages/protocol`.
- Integration tests for every endpoint and the reset command, including refusal cases; GitHub calls tested against a local fake.
- `docs/user/`: password reset page (the command is user-facing even before the UI exists).
- ADRs: Argon2 and session model, secret encryption scheme, GitHub token verification.

**Done when** the API can create the owner, log in and out, save, check and encrypt a GitHub token and report its expiry and missing permissions; `reset-password` works in the container; tests prove the token never leaves the server.

### [x] D. Web UI shell, wizard screens and Help section

- `apps/web`: React + Vite + TanStack Query + Tailwind, served by the server as static files.
- Screens: setup wizard steps 1 and 2 ending on the Done page (02, section 3), login, app shell with the navigation of 02, section 2 (sections of later lots show "Coming in a later version"), Settings > GitHub connection (status, expiry date, check, replace token), a minimal "Needs you" page showing the token expiry warning (14 days, a setting) and missing permissions.
- Help: `docs/user/` rendered with navigation and search (02, section 11), contextual help links from the wizard and login.
- `docs/user/`: `index.md`, `getting-started.md` (start the stack on WSL, create the account, connect GitHub), a GitHub token page listing the required permissions and how to create the token.
- Playwright end-to-end tests of the wizard and Help, running in CI and locally in the Playwright Docker image; `pnpm test:e2e` becomes real.
- ADRs: React + Vite + TanStack Query + Tailwind, Playwright, Markdown rendering library.

**Done when** Playwright covers first launch → account → GitHub token → Help page, all green in CI, and every screen works on a phone-sized viewport.

*Done 2026-09-23.* End-to-end tests run in the pinned Playwright image locally and in CI (ADR 0021); every test runs on a desktop and a phone viewport. ADRs 0018 to 0021.

### [x] E. End-to-end check of the lot 0 scenario on WSL

- Follow `docs/user/getting-started.md` literally on a clean WSL checkout: start the stack with Docker Compose, create the account, connect GitHub with a real fine-grained token, read the guide in the Help section.
- Confirm with the owner's real token the GitHub answers the token check relies on (ADR 0017): with each write permission removed in turn, the invalid requests are refused as "not accessible", and with it granted they fail validation.
- Fix any gap in the documentation or code found on the way (each fix with its test).
- Record the result in this plan; the owner runs the same scenario to close the lot (10, "Rules for every lot").

**Done when** the scenario passes following the user documentation alone, and the owner has confirmed it.

*Done 2026-09-23.* The owner ran the scenario on a clean WSL checkout, following `docs/user/getting-started.md` literally with a real fine-grained token: completed without problems up to the Done page. Token check with the real GitHub, one permission removed at a time, then "Check again":

| Token change | Result | Correct |
|---|---|---|
| Administration removed | only Administration Missing | yes |
| Pull requests removed | only Pull requests Missing | yes |
| Workflows removed | only Workflows Missing | yes |
| Contents set to read-only | Contents Missing, Workflows also Missing | Contents yes, Workflows no |

GitHub refuses a workflow file without Contents write before looking at Workflows. Fixed: a probe depending on a permission that is not OK is not sent and shows Could not verify with the reason ("Requires Contents (Read and write) first"), with a regression test. ADR 0022 supersedes ADR 0017 with these results; 02 section 3.2 and the GitHub token help page updated. Lot 0 is closed as version 0.1.0.

## Decisions taken on the open questions (2026-09-23)

- The script running everything CI runs is `pnpm verify` (`pnpm ci` is a built-in pnpm command).
- Compose files are `docker/compose.yml` and `docker/compose.dev.yml` (09 updated).
- The owner logs in with a username; password of at least 12 characters; password reset by a command in the server container (01 section 3.11, 09 section 7.4).
- GitHub token permissions, expiry display and warning: 02, section 3.1 (to verify against GitHub's documentation at the start of step C).
- Token check against GitHub's documentation (step C, 2026-09-23): no Checks permission for fine-grained tokens (`ci.status` uses Actions and commit statuses, 06 updated); Workflows has a single level; Metadata is added automatically; tokens may have no expiry; the token is for the owner's personal account. GitHub cannot list a token's permissions or reliably give its expiry date: the owner enters the date, and the check probes permissions without changing anything (02 section 3.2, ADR 0017).
- The wizard covers only existing steps and ends on a Done page; later steps appear in "Needs you" (02, sections 3 and 4).
- End-to-end tests (step D, 2026-09-23): Chromium's system libraries are missing on the owner's WSL and are not installed; the tests run in the pinned Playwright Docker image, locally and in CI (ADR 0021). Host runs keep browsers in `.playwright-browsers/` in the repository.

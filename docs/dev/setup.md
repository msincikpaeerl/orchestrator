# Development setup

## Requirements

| Tool | Version | Notes |
|---|---|---|
| Node.js | 24 LTS, exact version in `.nvmrc` | `nvm install` reads `.nvmrc`. |
| pnpm | pinned by `packageManager` in `package.json` | `corepack enable`, or the standalone pnpm installer. |
| Git | 2.40 or later | The daemon's tests use bare clones and worktrees (from lot 2). |
| tmux | 3.2 or later (`tmux -V`) | The daemon's tests drive real tmux sessions with a fake `claude` (from lot 2 step F). Installed from the system's packages, so the version cannot be pinned; CI prints `tmux -V` in its log. |
| `tar`, `openssl` | from the system | `tar` packs the daemon in `pnpm build`; `openssl` makes the test certificates of the daemon's `doctor` tests. Both come with Ubuntu and the CI runner. |
| Docker | Engine or Docker Desktop with Compose v2.24 or later | Database for development and tests, end-to-end tests, full stack. |

Windows is supported through WSL 2 only. The real Claude Code is never needed for development or tests (working rule 10); the owner's machines need it to run agents (`docs/user/`, from lot 2).

## First run

```sh
pnpm install
docker compose -f docker/compose.dev.yml up -d --wait
pnpm verify
```

`pnpm verify` must pass on a fresh clone. It runs lint, format check, type check, tests, build and the documentation link check. The integration and end-to-end tests need the test PostgreSQL; without it they fail with the command above.

`docker/compose.dev.yml` runs two PostgreSQL servers (user, password and database `orchestrator` on both):

| Service | Address | For | Data |
|---|---|---|---|
| `postgres` | `127.0.0.1:5432` | `pnpm dev` | `orchestrator-dev_postgres-data` volume |
| `postgres-test` | `127.0.0.1:5433` | the tests' throw-away databases | in memory, durability turned off for speed (ADR 0031): deleted at every stop or restart, never keep data there |

Stop them with `docker compose -f docker/compose.dev.yml down`; add `-v` to delete the development data too.

## Commands

| Command | What it does |
|---|---|
| `pnpm install` | Install all workspace dependencies from the lock file. |
| `pnpm verify` | Everything CI runs. Run it before finishing any change. |
| `pnpm lint` | ESLint, then the Prettier check. |
| `pnpm format` | Rewrite files with Prettier (Markdown is excluded, ADR 0007). |
| `pnpm typecheck` | `tsc` on the root config files and every package. |
| `pnpm test` | Vitest, all packages. |
| `ORCHESTRATOR_TEST_SYSTEMD=1 pnpm exec vitest run --project apps/daemon test/systemd.test.ts` | The daemon's systemd scope tests, on a host with a systemd user session (WSL with systemd): they create transient `od-test-*` units only and stop them (`docs/dev/testing.md`). Skipped otherwise, and in CI. |
| `pnpm build` | Build every package into its `dist/`; the daemon's is its package, `orchestrator-daemon-<version>.tgz` (ADR 0026). |
| `pnpm docs:links` | Check relative links and headings in all Markdown files. |
| `pnpm test:e2e` | End-to-end tests in the Playwright Docker image, as CI runs them (`docs/dev/testing.md`). Needs the test PostgreSQL. |
| `pnpm test:e2e:host` | The same on the host, with Chromium downloaded into `.playwright-browsers/`; needs Chromium's system libraries. |
| `pnpm dev` | Server from the TypeScript sources, restarted on change, with the root `.env`, and the UI with Vite on `http://localhost:5173`. |
| `pnpm --filter server orchestrator reset-password` | The `orchestrator reset-password` command of the image, on the database of the root `.env` (09, section 7.4). |
| `pnpm --filter db migrate:generate` | Write a SQL migration for the changes in `packages/db/src/schema.ts` (ADR 0011). |
| `pnpm --filter @orchestrator/daemon dev <command>` | The daemon from its sources, for example `... dev doctor` or `... dev start`. It uses `~/.orchestrator/`; set `ORCHESTRATOR_HOME` to another folder to keep a development daemon apart. Tests never use it. |
| `tools/smoke/claude-code-probe.sh`, `tools/smoke/allowlist-smoke.sh`, `tools/spike/claude-code-spike.sh` | The owner's checks with the real Claude Code (lot 2 steps H and N; `--help`), and the usage-limit capture (`--probe-limit` only while limited, `--scan-limit` with no session). Sessions never run them (working rule 10): they refuse in CI and without a terminal and ask for `yes`; CI runs their dry runs against the fake `claude` (`docs/dev/testing.md`). |
| `pnpm --filter <package> <script>` | Run a script in one package. |

Do not use `pnpm ci`: it is a built-in pnpm command (clean install), not our CI script (ADR 0005).

## Workspace layout

See `docs/dev/architecture.md`. Packages are named `@orchestrator/<folder>`. Libraries in `packages/` export their TypeScript sources under the `source` condition, so type checks and tests run without building first.

## Adding a dependency

- Use `pnpm add --save-exact <package>@<version>` in the package that needs it, after checking the current version with `npm view <package> version`.
- Explain the reason in the commit message; a major dependency needs an ADR.

## Environment variables

Listed in `.env.example` with their purpose (09, section 7.1). Copy it to `.env` at the repository root and set `ORCHESTRATOR_SECRET_KEY` (`openssl rand -base64 32`); `.env` is ignored by Git. Both `pnpm dev` and `docker/compose.yml` read it. The server refuses to start and names the variable when one is missing or invalid. Leave `PUBLIC_URL` unset unless the Orchestrator is reached from another host, through a reverse proxy or over HTTPS. Outside `localhost`, HTTPS is recommended (`docs/user/network-access.md`): the login cookie is marked `Secure` only when `PUBLIC_URL` is `https://`, so plain HTTP on a LAN address still works. If `ORCHESTRATOR_SECRET_KEY` changes, the server still starts and reports the saved GitHub token as unreadable (ADR 0016).

| Variable | `pnpm dev` | `docker/compose.yml` |
|---|---|---|
| `DATABASE_URL` | used | ignored: the stack uses its own PostgreSQL |
| `ORCHESTRATOR_SECRET_KEY` | required | required: Compose stops with a message if it is empty |
| `PUBLIC_URL` | optional, defaults to `http://localhost:<PORT>` | optional, defaults to `http://localhost:<PORT>` (host port) |
| `PORT` | port the server listens on, default 8080 | port published on the host, default 8080 |
| `LOG_LEVEL` | default `info` | default `info` |

## Running the server

```sh
docker compose -f docker/compose.dev.yml up -d --wait postgres
pnpm dev
```

`pnpm dev` starts two processes: the server on `PORT` (default 8080) and Vite on `http://localhost:5173`. Open the UI on port 5173: changes to `apps/web` show at once, and Vite forwards `/api` to the server. The Help section reads `docs/user/` directly. The server applies pending database migrations at start. Logs are JSON (ADR 0013).

The server also serves the built UI (`apps/web/dist`, from `pnpm build`) on its own port, as in production; without it, it logs "UI not built: serving the API only".

## Full stack in Docker

```sh
docker compose -f docker/compose.yml up --build
```

Builds the server image (`docker/Dockerfile`) and starts it with its own PostgreSQL on `http://localhost:8080`, or the port set by `PORT` (ADR 0014). The root `.env` is required. `docker/compose.yml` only loads it and includes `docker/services.yml`, which declares the containers: Compose otherwise reads `.env` from the compose file's folder only. A variable set in the shell takes precedence over `.env`, for example `PORT=9000 docker compose -f docker/compose.yml up`. The Compose project is `orchestrator`; data is in the `orchestrator_postgres-data` volume. The development database can run at the same time: it uses another project and volume.

## Database migrations

1. Change `packages/db/src/schema.ts`.
2. Run `pnpm --filter db migrate:generate` and read the SQL written in `packages/db/migrations/`.
3. Commit the schema change and the migration together. Migrations are forward only (ADR 0011).

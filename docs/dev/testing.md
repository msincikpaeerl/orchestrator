# Testing

## Levels

| Level | Tool | Location | Runs with | Status |
|---|---|---|---|---|
| Unit | Vitest | next to the code, `*.test.ts` | `pnpm test` | in place |
| Integration | Vitest, real PostgreSQL (dev compose database) | `apps/*/test/`, `packages/*/test/` | `pnpm test` | in place |
| End-to-end | Playwright | `apps/web/e2e/` | `pnpm test:e2e` | from lot 0 step D |
| Documentation links | remark-validate-links | all `*.md` | `pnpm docs:links` | in place |

Rules (also in CLAUDE.md):

- New behaviour needs tests; a bug fix needs a regression test that fails before the fix.
- Integration tests use the real database, never mocks of it.
- The daemon's tmux and Claude Code layer is tested against a fake `claude` executable; no real Claude Code in CI.
- Never weaken or delete a test to make CI pass.

## Integration tests

They need the development PostgreSQL:

```sh
docker compose -f docker/compose.dev.yml up -d --wait postgres
```

GitHub is replaced by a local fake (`apps/server/test/fake-github.ts`) that answers like GitHub for the requests the server makes: tests configure the valid tokens and their permissions. The server takes the API address as `githubApiUrl` in `buildApp`. `apps/server/test/helpers.ts` starts the application on a new database and captures its logs, so tests can prove that passwords and tokens never reach them.

Each test file calls `createTestDatabase()` from `@orchestrator/db/testing`: it creates an empty database with a random name on that server, and `drop()` removes it. Tests then apply the migrations themselves or through `startServer`. Set `TEST_DATABASE_URL` to use another PostgreSQL server (the database part of the URL is replaced).

## Running tests

```sh
pnpm test                          # all packages
pnpm test --project apps/server    # one package
pnpm exec vitest                   # watch mode
```

The root `vitest.config.ts` declares one project per folder in `apps/` and `packages/` (ADR 0006). A new package is picked up automatically.

## Continuous integration

`.github/workflows/ci.yml` runs on pull requests and pushes to `main` (ADR 0008):

- Job `verify`, with a PostgreSQL service (same image as `docker/compose.dev.yml`):
  1. `pnpm install --frozen-lockfile`
  2. `pnpm verify` (lint, format check, type check, tests, build, link check)
  3. `pnpm audit --audit-level critical`
- Job `docker`: builds the image, starts `docker/compose.yml` with a generated `.env`, and checks `/health` and `/version`.

To check the workflow file locally:

```sh
docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:1.7.12
```

CI must stay under 10 minutes (08, section 4).

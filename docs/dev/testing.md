# Testing

## Levels

| Level | Tool | Location | Runs with | Status |
|---|---|---|---|---|
| Unit | Vitest | next to the code, `*.test.ts` | `pnpm test` | in place |
| Integration | Vitest, real PostgreSQL (dev compose database) | `apps/*/test/`, `packages/*/test/` | `pnpm test` | in place |
| End-to-end | Playwright, in the pinned Playwright Docker image | `apps/web/e2e/*.e2e.ts` | `pnpm test:e2e` | in place |
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

GitHub is replaced by a local fake (`apps/server/test/fake-github.ts`) that answers like GitHub for the requests the server makes: tests configure the valid tokens, their permissions, the account's plan and repositories. Repositories keep commits, trees, branches and rulesets in memory; `repositoryHistory` and `repositoryFiles` read them back, and `override` injects any answer (for example a refusal) for one request. The server takes the API address as `githubApiUrl` in `buildApp`. `apps/server/test/helpers.ts` starts the application on a new database and captures its logs, so tests can prove that passwords and tokens never reach them.

Rules about concurrent requests (ticket numbers, dependency cycles, project keys) are tested by sending the requests at the same time with `Promise.all`; the dependency test was checked to fail without the project lock. Ticket states no lot 1 action reaches (`proposed`, `in_progress`, ...) are seeded directly in the database, never through an API.

Each test file calls `createTestDatabase()` from `@orchestrator/db/testing`: it creates an empty database with a random name on that server, and `drop()` removes it. Tests then apply the migrations themselves or through `startServer`. Set `TEST_DATABASE_URL` to use another PostgreSQL server (the database part of the URL is replaced).

## Running tests

```sh
pnpm test                          # all packages
pnpm test --project apps/server    # one package
pnpm exec vitest                   # watch mode
```

The root `vitest.config.ts` declares one project per folder in `apps/` and `packages/` (ADR 0006). A new package is picked up automatically.

## End-to-end tests

Playwright drives Chromium through the UI, on a desktop screen and on a phone (Pixel 7): every test runs on both, and checks that no screen scrolls sideways (02, section 1). They run in the Playwright Docker image pinned in `tools/e2e-docker.sh` and `.github/workflows/ci.yml`, locally and in CI alike (ADR 0021): nothing is installed on the host.

### Run them locally with Docker

```sh
docker compose -f docker/compose.dev.yml up -d --wait postgres
pnpm test:e2e                         # all tests, desktop and phone
pnpm test:e2e --project=phone         # phone only
pnpm test:e2e setup.e2e.ts            # one file
```

`pnpm test:e2e` builds the UI, then runs `playwright test` in the image with the repository mounted at the same path, the host network (the tests use the development PostgreSQL on `localhost:5432`) and your user, so the files it writes are yours. The first run pulls the image. Results are in `apps/web/test-results/` (a trace for each failed test: `apps/web/node_modules/.bin/playwright show-trace <file>`) and, with `CI` set, a report in `apps/web/playwright-report/`.

Playwright starts `apps/server/test/e2e-server.ts` on port 8095 (`E2E_PORT`), with the built UI, a throw-away database and the fake GitHub, whose tokens are in `apps/web/e2e/fixtures.ts`. Before each test, the `fresh` fixture empties the database and resets the fake GitHub through a control address on the next port, so every test starts from the first launch. The fake account has repositories to link (`notes`, `legacy-site`, and `old-archive`, archived). The `failNextGitHubRequest` fixture uses the same control address to make the next GitHub request with a given method and path ending fail (for example a 503 on `POST .../git/trees` for a failed setup); this control exists only in the test server, never in the Orchestrator. Tests run one at a time.

### Run them on the host

Only when Chromium's system libraries are installed (`apps/web/node_modules/.bin/playwright install-deps --dry-run chromium` lists the missing ones; installing them needs root, which is the owner's decision). Then `pnpm test:e2e:host` downloads Chromium into `.playwright-browsers/` at the repository root (ignored by Git), never into the home folder, and runs the tests.

### Upgrading Playwright

Change `@playwright/test` in `apps/web/package.json` and the image tag in `tools/e2e-docker.sh` and `.github/workflows/ci.yml` together; `apps/web/e2e/image-version.test.ts` fails otherwise.

## Continuous integration

`.github/workflows/ci.yml` runs on pull requests and pushes to `main` (ADR 0008):

- Job `verify`, with a PostgreSQL service (same image as `docker/compose.dev.yml`):
  1. `pnpm install --frozen-lockfile`
  2. `pnpm verify` (lint, format check, type check, tests, build, link check)
  3. `pnpm audit --audit-level critical`
- Job `e2e`, in the Playwright image with a PostgreSQL service: installs dependencies with the image's Node.js and pnpm (Corepack, pnpm store cached), builds the UI and runs `playwright test`. The report and traces of failed tests are kept as the `playwright-report` artifact for 7 days.
- Job `docker`: builds the image, starts `docker/compose.yml` with a generated `.env`, and checks `/health`, `/version` and that a screen address returns the UI.

To check the workflow file locally:

```sh
docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:1.7.12
```

CI must stay under 10 minutes (08, section 4).

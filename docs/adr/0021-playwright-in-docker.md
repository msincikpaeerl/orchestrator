# 0021 — Playwright end-to-end tests in the pinned Playwright image

- Status: accepted
- Date: 2026-09-23

## Context

09, section 3 chooses Playwright for end-to-end tests. Its browsers need system libraries that are not installed on the owner's WSL (Ubuntu 26.04), which has no root access for agents; installing anything outside the repository is forbidden (CLAUDE.md). By default Playwright also downloads browsers into the home folder. Local runs and CI should behave the same.

## Decision

- End-to-end tests run in Microsoft's Playwright image, pinned to the exact `@playwright/test` version: `mcr.microsoft.com/playwright:v1.63.0-noble`. It contains the browsers and their libraries, so nothing is downloaded or installed on the host.
- **Locally**, `pnpm test:e2e` (`tools/e2e-docker.sh`) builds the UI on the host, then runs `playwright test` in the image with the repository mounted at the same path, the host network (to reach the development PostgreSQL) and the current user.
- **In CI**, the `e2e` job runs in the same image as a job container, with a PostgreSQL service: it installs dependencies with the image's Node.js and pnpm (through Corepack), builds the UI and runs the same `playwright test`. The pnpm store is cached.
- `apps/web/e2e/image-version.test.ts` fails when the image tag in the script or the workflow differs from the `@playwright/test` version.
- For runs directly on the host (once the owner has installed the libraries Playwright lists), `pnpm test:e2e:host` sets `PLAYWRIGHT_BROWSERS_PATH` to `.playwright-browsers/` in the repository (ignored by Git) and downloads Chromium there, never into the home folder.
- Playwright starts `apps/server/test/e2e-server.ts`: the server with the built UI, a throw-away database and the fake GitHub of the integration tests. Each test empties the database first. Every test runs twice: on a desktop screen and on a phone (Pixel 7), and checks that screens never scroll sideways.

## Alternatives considered

- Browsers installed on the runner with `playwright install --with-deps` and cached in CI: CI and local runs would differ (Ubuntu 24.04 runner, Ubuntu 26.04 host), and local runs would need system libraries installed with root access.
- Running only CI end to end: failures could not be reproduced locally.

## Consequences

- Local runs need Docker, as the database already does. The image takes about 3.5 GB of disk space once pulled.
- The image's Node.js (24.20.0) is slightly older than `.nvmrc` (24.21.0); the tests only run the server under test with it. Upgrading `@playwright/test` means changing the tag in `tools/e2e-docker.sh` and `.github/workflows/ci.yml` in the same commit.
- The image is Ubuntu 24.04 (glibc 2.39), compatible with dependencies installed on the Ubuntu 26.04 host.

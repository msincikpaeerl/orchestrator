# 0008 — GitHub Actions for continuous integration

- Status: accepted
- Date: 2026-09-23

## Context

Projects are hosted on GitHub; CI results are read back through the GitHub API (09, section 4). 08, section 4 lists the checks and a 10-minute limit. 09, section 5 requires `pnpm audit` failing on critical vulnerabilities.

## Decision

- One workflow, `.github/workflows/ci.yml`, on pull requests and pushes to `main`.
- Steps: install pnpm (version from `packageManager`), set up Node.js from `.nvmrc` with the pnpm store cached, `pnpm install --frozen-lockfile`, `pnpm verify`, `pnpm audit --audit-level critical`.
- Actions are pinned to exact release tags; the job has read-only permissions and a 10-minute timeout.
- CI runs the same `pnpm verify` as developers, so a green local run predicts a green CI run. Later steps add services (PostgreSQL) and end-to-end tests to this workflow.

## Alternatives considered

- Other CI services: an extra account and integration, while GitHub is already required.

## Consequences

- The workflow can be checked locally with `actionlint` (see `docs/dev/testing.md`).
- A new critical advisory in any dependency fails CI until it is upgraded or resolved.

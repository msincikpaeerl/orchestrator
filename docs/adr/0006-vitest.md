# 0006 — Vitest for unit and integration tests

- Status: accepted
- Date: 2026-09-23

## Context

09, section 3 chooses Vitest for unit and integration tests and Playwright for end-to-end tests. Playwright is introduced with the UI (lot 0, step D) and gets its own ADR then.

## Decision

- Vitest runs all unit and integration tests from the repository root with `pnpm test`.
- The root `vitest.config.ts` declares one project per workspace package; projects inherit the root settings, including resolving workspace packages to their TypeScript sources.
- Unit tests sit next to the code (`*.test.ts`); integration tests in `apps/*/test/` (CLAUDE.md).

## Alternatives considered

- Jest: slower with TypeScript and ES modules, needs extra transforms.
- `node:test`: no watch UI, weaker mocking and reporting, fewer agents know it well.

## Consequences

- One command runs every package's tests; a single package can be run with `pnpm test --project apps/server`.
- Generated `web_app` projects use the same tool (08, section 3.3).

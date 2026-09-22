# 0003 — TypeScript everywhere, strict, version 6.0

- Status: accepted
- Date: 2026-09-23

## Context

The server, UI and daemon share message and tool schemas (`packages/protocol`). Most code is written by agents and must be checked by machines before review (08, section 1). 09, section 3 chooses TypeScript for all three applications.

## Decision

- All code is TypeScript, compiled with `tsc`, with the shared `tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax`, `module`/`moduleResolution` `nodenext`, ES modules only.
- Workspace libraries expose their sources through the `source` export condition (`customConditions`), so type checks and tests work without building first; builds emit `dist/`.
- TypeScript is pinned to **6.0.x**, not 7.0 (the current release, the native compiler): `typescript-eslint` 8.70, needed for type-aware lint rules, supports TypeScript `<6.1.0` only. Move to 7 in its own change when `typescript-eslint` supports it.

## Alternatives considered

- JavaScript with JSDoc types: weaker checks, types not shared as naturally.
- TypeScript 7.0 without type-aware linting: faster builds, but loses the lint rules that catch unsafe `any` and unhandled promises in agent-written code.

## Consequences

- One language and one set of tools for all applications.
- `any` needs a comment explaining why (CLAUDE.md).
- A later upgrade to TypeScript 7 is expected; it must keep `pnpm verify` green.

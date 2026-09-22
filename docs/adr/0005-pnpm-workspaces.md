# 0005 — pnpm workspaces monorepo

- Status: accepted
- Date: 2026-09-23

## Context

Three applications (server, UI, daemon) and two libraries (protocol, database) are released together with one version (09, sections 2 and 6).

## Decision

- One repository with pnpm workspaces: `apps/*` and `packages/*`. Package names are `@orchestrator/<folder>`; `pnpm --filter <folder>` works without the scope.
- pnpm is pinned with the `packageManager` field (currently `pnpm@12.5.1`); `pnpm-lock.yaml` is committed and CI installs with `--frozen-lockfile`.
- Dependencies are pinned to exact versions (`--save-exact`).
- The script that runs everything CI runs is `pnpm verify`. It is not called `ci` because `pnpm ci` is a built-in pnpm command (clean install) that would silently run instead.

## Alternatives considered

- npm workspaces: slower, looser dependency isolation (phantom dependencies).
- Yarn: no advantage here over pnpm, and less familiar to agents.
- Several repositories: shared schemas would need publishing and version juggling.
- Turborepo or Nx on top: unnecessary for five small packages; `pnpm -r` runs scripts in dependency order.

## Consequences

- Workspace packages depend on each other with `workspace:*`.
- Upgrading pnpm means changing `packageManager` and regenerating the lock file.

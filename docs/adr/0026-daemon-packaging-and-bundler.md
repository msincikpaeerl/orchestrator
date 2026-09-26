# 0026 — Daemon packaging and bundler

- Status: accepted
- Date: 2026-09-26

## Context

The daemon runs on the owner's machines, outside Docker (05, section 2). The owner installs it with `npm install -g <server URL>/downloads/orchestrator-daemon-<version>.tgz`, from the server of the same version, and nothing is published to the npm registry (owner's decision, lot 2 step A). The daemon uses workspace packages (`@orchestrator/protocol`, TypeScript sources) and libraries (`ws`, ADR 0025; `pino`, ADR 0013; `zod`, ADR 0012). An install from a tarball URL must not need the npm registry for the workspace packages, and should not download anything else either. The machine has Node.js 24; nothing else can be assumed.

## Decision

- **Bundler: esbuild 0.28.2** (already in the lock file through `tsx`). `apps/daemon/scripts/pack.ts` bundles `src/cli.ts` and everything it imports into one ES module file, `dist/orchestrator-daemon.js`, for Node.js 24, with a `#!/usr/bin/env node` line and a `require` made with `createRequire` for the bundled CommonJS libraries. Workspace packages are read from their TypeScript sources (`source` condition). The optional native modules of `ws` (`bufferutil`, `utf-8-validate`) stay external: `ws` works without them.
- **Package**: `orchestrator-daemon`, of the daemon's version (the shared version, 09 section 6), with a `bin` entry, `engines` Node.js 24, no dependencies, and `THIRD-PARTY-LICENSES.txt` holding the license of every bundled library (taken from esbuild's metafile). The archive is made with `tar` (sorted names, owner 0, date 0) and gzip from Node.js without a timestamp, so the same sources give the same archive; no `npm pack`, which would write to the home folder's npm cache.
- **Build**: `pnpm build` in `apps/daemon` writes `apps/daemon/dist/orchestrator-daemon-<version>.tgz`. The daemon's libraries are `devDependencies`: they are inside the bundle, so the server's image (`pnpm deploy --prod`) carries only the archive.
- **Serving**: the server depends on `@orchestrator/daemon` (like `@orchestrator/web`, ADR 0018) and serves `GET /downloads/orchestrator-daemon-<its version>.tgz` without a session; any other version is not found. The install command shown in the UI points to it.

## Alternatives considered

- **Publishing to the npm registry**: refused by the owner (lot 2 step A); it would also allow a daemon version different from the server's.
- **`npm pack` of the workspace package**: the workspace dependencies (`workspace:*`) cannot be installed from a tarball, and the libraries would be downloaded from the registry at each install.
- **Rollup or tsup**: they bundle as well, with more configuration for Node.js CommonJS libraries; esbuild is already present and fast.
- **Node.js single executable applications**: a ~100 MB binary per platform, still experimental for ES modules, and it would bypass the Node.js the service is meant to use (05, section 2).

## Consequences

- One file to install, no registry access on the machine; `npm install -g` works with nvm without `sudo`.
- The daemon's version always matches the server's: updating the server gives the update command for the daemon (02, section 4).
- Build machines need `tar` (present in the build image and in CI).
- Bundled library licenses must stay in the package: the build fails when a bundled library has no license file.
- A test installs the served package into a temporary prefix and runs it (`apps/server/test/daemon-package.test.ts`).

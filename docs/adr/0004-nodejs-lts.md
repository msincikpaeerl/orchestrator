# 0004 — Node.js LTS as the runtime

- Status: accepted
- Date: 2026-09-23

## Context

Claude Code runs on Node.js, so every machine already has it. The server runs in Docker, the daemon on the host (09, section 3).

## Decision

- Node.js **24** (Active LTS "Krypton"), pinned to an exact version in `.nvmrc` (currently 24.21.0).
- `engines.node` in `package.json` accepts `>=24.21.0 <25`. CI reads `.nvmrc`; the server Docker image uses the same version.
- Move to the next LTS line (26) in its own change once it enters Active LTS.

## Alternatives considered

- Node.js 22: still maintained, but in maintenance LTS; starting a new project on it means an earlier forced upgrade.
- Node.js 26 (current, not yet LTS): fine for development, but LTS is the rule for anything the owner installs.
- Bun or Deno: not what Claude Code uses; one more runtime to install on each machine.

## Consequences

- Developers need Node.js 24 (for example with `nvm install`, which reads `.nvmrc`).
- The daemon's install instructions (lot 2) require Node.js 24.

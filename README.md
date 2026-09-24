# Orchestrator

A self-hosted tool that turns plain-language requests into web apps, websites and Android apps by coordinating AI agents running in Claude Code. You describe what you want, approve the plan, and merge the pull requests; agents do the rest on your own machines.

**Status:** version 0.2.0, lot 1 of the [delivery plan](docs/specs/10-delivery-plan.md): account, GitHub connection, projects with their GitHub repository, tickets, limits, event log and Help. Start with [Getting started](docs/user/getting-started.md).

## Documentation

- User guide: [`docs/user/`](docs/user/index.md), also shown in the application's Help section.
- Specifications: [`docs/specs/`](docs/specs/README.md).
- Development: [setup](docs/dev/setup.md), [testing](docs/dev/testing.md), [architecture](docs/dev/architecture.md), [decisions](docs/adr/).
- Instructions for agents: [`CLAUDE.md`](CLAUDE.md).

## Quick start for developers

```sh
pnpm install
pnpm verify
```

Requires Node.js 24 (see `.nvmrc`) and pnpm (pinned in `package.json`).

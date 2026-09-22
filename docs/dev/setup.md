# Development setup

## Requirements

| Tool | Version | Notes |
|---|---|---|
| Node.js | 24 LTS, exact version in `.nvmrc` | `nvm install` reads `.nvmrc`. |
| pnpm | pinned by `packageManager` in `package.json` | `corepack enable`, or the standalone pnpm installer. |
| Git | any recent | |
| Docker | Engine or Docker Desktop with Compose | Needed from lot 0 step B (database, full stack). |

Windows is supported through WSL 2 only.

## First run

```sh
pnpm install
pnpm verify
```

`pnpm verify` must pass on a fresh clone. It runs lint, format check, type check, tests, build and the documentation link check.

## Commands

| Command | What it does |
|---|---|
| `pnpm install` | Install all workspace dependencies from the lock file. |
| `pnpm verify` | Everything CI runs. Run it before finishing any change. |
| `pnpm lint` | ESLint, then the Prettier check. |
| `pnpm format` | Rewrite files with Prettier (Markdown is excluded, ADR 0007). |
| `pnpm typecheck` | `tsc` on the root config files and every package. |
| `pnpm test` | Vitest, all packages. |
| `pnpm build` | Build every package into its `dist/`. |
| `pnpm docs:links` | Check relative links and headings in all Markdown files. |
| `pnpm test:e2e` | Placeholder until lot 0 step D (Playwright). |
| `pnpm dev` | Placeholder until lot 0 step B (server) and D (UI). |
| `pnpm --filter <folder> <script>` | Run a script in one package, for example `pnpm --filter daemon dev`. |

Do not use `pnpm ci`: it is a built-in pnpm command (clean install), not our CI script (ADR 0005).

## Workspace layout

See `docs/dev/architecture.md`. Packages are named `@orchestrator/<folder>`. Libraries in `packages/` export their TypeScript sources under the `source` condition, so type checks and tests run without building first.

## Adding a dependency

- Use `pnpm add --save-exact <package>@<version>` in the package that needs it, after checking the current version with `npm view <package> version`.
- Explain the reason in the commit message; a major dependency needs an ADR.

## Environment variables

Listed in `.env.example` with their purpose (09, section 7.1). Copy it to `.env` for local runs; `.env` is ignored by Git. Used from lot 0 step B.

# CLAUDE.md — {{name}}

Instructions for Claude Code working on this repository. Keep this file under 150 lines.
Details belong in `docs/`; this file only points to them.

## What this project is

{{description}}

## Current state

New project: the stack is not chosen yet. The first ticket records it in ADRs and completes this file (commands, folder map, conventions).

## Read before working

1. The ticket you were given.
2. The documentation of the area you touch in `docs/dev/`.
3. The decisions in `docs/adr/` related to that area.

## Commands

| Task | Command |
|---|---|
| Documentation link check | `npx remark . --frail --quiet --no-stdout` (after the CI's install step, see `.github/workflows/ci.yml`) |

## Repository map

```
docs/user/   User documentation, organised by tasks
docs/dev/    Developer documentation (architecture, setup, testing)
docs/adr/    Architecture Decision Records
.github/     CI and the pull request template
```

## Conventions

- Commits follow Conventional Commits with the ticket number: `feat(WEB-12): add contact form`.
- Every significant technical choice gets an ADR: copy `docs/adr/0000-template.md`, next number.
- A user-visible change updates `docs/user/` and `CHANGELOG.md` in the same pull request.
- Keep the `docs-links` CI job: branch protection requires it.
- All text in English.

## Never

- Never commit secrets. Environment variables are listed in `.env.example` once the project has any.
- Never weaken or delete a test to make CI pass.
- Never push to the default branch: work on the ticket branch.

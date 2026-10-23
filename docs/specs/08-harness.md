# 08 — Harness and Project Template

> Status: Draft v0.1
> Related: [00 — Vision and Scope](00-vision-and-scope.md), [03 — Agents](03-agents.md), [04 — Ticket Lifecycle](04-ticket-lifecycle.md)

The harness is the set of documents, tests, automation and recorded decisions that lets agents work reliably and lets the owner use a project without reading its code. This document defines what every project contains, how it is created, and how the system keeps it alive.

The Orchestrator itself follows this document.

## 1. Goals

1. **Agents find their way alone.** An agent starting a run can learn how to build, test and change the project from the repository in a few files.
2. **Mistakes are caught by machines first.** Lint, type checks, tests and builds run on every pull request.
3. **Decisions are not lost.** Every significant technical choice is recorded with its reasons.
4. **The owner never needs the code.** User documentation explains every feature from the user's point of view.
5. **Context stays small.** Files agents read at every run are short, because every token costs quota.

## 2. Repository layout

Every project has this layout, whatever its kind.

```
README.md              What the project is, how to run it, links to docs. One screen.
CLAUDE.md              Instructions for agents (section 2.1).
CHANGELOG.md           User-facing changes, one entry per merged ticket.
docs/
  user/                User documentation (section 2.2).
    index.md
    getting-started.md
  dev/                 Developer documentation.
    architecture.md    Components and how they fit together.
    setup.md           Local setup, commands, environment variables.
    testing.md         Test strategy and how to run each level.
  adr/                 Architecture Decision Records (section 2.3).
    0000-template.md
    0001-record-architecture-decisions.md
.github/
  workflows/ci.yml     CI (section 4).
  pull_request_template.md
```

### 2.1 CLAUDE.md

The most important file for agents. Rules:

- **At most 150 lines.** The Quality agent rejects changes that exceed it.
- Contains only what an agent needs at every run: commands (install, build, test, lint, run), folder map, coding conventions, testing conventions, documentation rules, things never to do.
- Points to `docs/dev/` and `docs/adr/` for details instead of copying them.
- Owned by the Architect; builders propose changes through their pull requests when conventions evolve.

### 2.2 User documentation

- Written for someone who uses the product and never reads its code.
- Organised by tasks ("Send a message through the contact form"), not by components.
- Every user-visible feature has a page or a section, updated in the same pull request as the feature (04, section 3.3).
- Includes: getting started, one page per feature area, settings reference, troubleshooting.
- Plain Markdown. Rendered in the product when the product has a UI for it (the Orchestrator does, in its Help section).
- English only.

### 2.3 Architecture Decision Records

- One file per decision: `NNNN-short-title.md`.
- Format: context, decision, alternatives considered, consequences, status (`proposed`, `accepted`, `superseded by NNNN`).
- Required for: choice of language, framework, database, major library, test tool, deployment approach, and any deviation from the default stack (section 3.2).
- ADRs are never edited after acceptance except their status; a new ADR supersedes an old one.

## 3. Project creation

A project is created either with a **new repository**, which receives the skeleton (section 3.1), or by **linking an existing repository** of the owner's personal account, which is left as it is (section 3.4). The owner creates projects from the Projects screen (02, section 6.2); from lot 5, approving a plan that creates a project does the same.

### 3.1 Skeleton

For a new repository, the server:

1. creates the GitHub repository on the owner's personal account: **private** by default, public when the owner chose it;
2. commits the **common skeleton** in one commit on the default branch: the layout above with placeholder content (project name and description filled in), ADR 0001 and the ADR template, a minimal CI that runs a documentation link check. The repository is created with GitHub's first commit (a README), because GitHub's API cannot build commits in an empty repository; the skeleton commit follows it and the default branch moves forward to it, never with a forced update. The history therefore has two commits;
3. applies branch protection on the default branch (pull request required, the final CI job `ci` required, section 4) when the GitHub plan allows it. GitHub Free does not offer it on private repositories: GitHub answers that the account must be upgraded or the repository made public. The project then shows "Branch protection: not available on your GitHub plan", which is information, not an error: the Orchestrator's own flow still prevents agents from pushing to the default branch, since only the daemon pushes and only ticket branches. Any other refusal is a failure of the setup.

Each step is recorded as an event. If a step fails, the project's setup is `failed` with the reason and the owner can try again; trying again resumes from the failed step.

The server never takes over a repository it did not create. When trying again finds a repository with the project's name (for example because GitHub created it but its answer was lost in a restart), it is reused only if both are true: GitHub created it after the attempt that sent the creation request started, give or take a clock tolerance (a setting, 2 minutes by default), and its default branch is empty or holds only GitHub's first commit (the README alone). Otherwise the setup fails with "Repository name already taken" and nothing is written to that repository.

### 3.2 Bootstrap ticket

Every plan for a new project starts with a bootstrap ticket assigned to the Architect (03, section 2.1). Its acceptance criteria are fixed:

- the stack is chosen and recorded in ADRs, following the defaults below unless the request justifies another choice;
- the project builds, and a sample test runs at each test level used by the project;
- lint, format check and type check (when applicable) are configured;
- CI runs all of the above on every pull request, plus the build artefact for Android;
- the documentation link check is moved into the stack's own tooling (for example a pinned dev dependency and a script), replacing the skeleton's npm install command in CLAUDE.md and CI; both stay identical;
- CLAUDE.md is complete (commands, folder map, conventions);
- `docs/dev/setup.md` and `docs/dev/testing.md` are written;
- `docs/user/getting-started.md` explains how to run the product.

All other tickets of the plan depend on it.

**As decided for lot 5** (owner's answers 5, 6 and 8, lot 5 step A):

- The Project Manager proposes the bootstrap ticket (`bootstrap: true`, `chore`, `architect`, blocked by nothing); the server adds the fixed criteria above that it lacks, from a template in `agents/templates/`, and adds it to every other ticket's `blocked_by` (06, section 4.4). The owner may edit them before approving, as any criterion.
- **End-to-end tests run locally and in CI**: on a machine with the capability `browser-tests` (05, section 2), which a new `website` or `web_app` project requires, the builders and Quality run them in the worktree; browsers come from `PLAYWRIGHT_BROWSERS_PATH`, set by the daemon, never a path written in the project. So the criterion "a sample test runs at each test level" holds on the machine and in CI, whose workflow installs the browsers and their libraries itself.
- **No Docker and no database locally** until lot 6, Isolated agent workspace (05, section 4.6): for a `web_app` with PostgreSQL, the integration tests' criterion holds in CI only, and its bootstrap ticket and `docs/dev/testing.md` say so.
- A project generator runs without prompts, and the bootstrap's checks use the build and the tests, never a development server left running (03, section 2.2).

### 3.3 Default stacks

Defaults keep projects consistent so agents and the owner do not relearn everything each time. The Architect may deviate with an ADR explaining why.

| Project kind | Default stack | Tests |
|---|---|---|
| `website` | Astro, TypeScript, static output | Vitest for logic, Playwright for key pages |
| `web_app` | React + Vite + TypeScript (front), Node.js + Fastify + TypeScript (back), PostgreSQL, Docker Compose for local run | Vitest (unit), integration tests against a test database, Playwright (end-to-end) |
| `android_app` | Kotlin, Jetpack Compose, Gradle Kotlin DSL | JUnit unit tests, Compose UI tests written but not run in v1 (no emulator) |

Common to all: ESLint and Prettier for TypeScript, ktlint for Kotlin, a lock file committed, Node.js LTS.

A `website` that must handle input on a server (a contact form saving its messages, for example) may add Astro's Node.js server adapter to the default stack, with an ADR recording why (owner's answer 2, lot 5 step A). Until lot 6, the `web_app` stack's PostgreSQL and Docker Compose are used in CI only (section 3.2).

### 3.4 Linked repositories

A linked repository is never changed by the project creation: no skeleton, no branch protection, no settings. The Orchestrator reads its default branch and looks for these harness elements:

| Element | Found when |
|---|---|
| CLAUDE.md | `CLAUDE.md` exists at the root. |
| User documentation | `docs/user/` contains at least one file. |
| Developer documentation | `docs/dev/` contains at least one file. |
| ADRs | `docs/adr/` contains at least one file. |
| CI workflow | `.github/workflows/` contains at least one `.yml` or `.yaml` file. |

The project page lists the missing ones, with a link to the Help page explaining each, and **Check again**. An empty repository has all of them missing. Missing elements do not prevent creating tickets.

## 4. Continuous integration

| Check | website | web_app | android_app |
|---|---|---|---|
| Install with lock file | ✓ | ✓ | ✓ |
| Lint and format check | ✓ | ✓ | ✓ |
| Type check | ✓ | ✓ | (compiler) |
| Unit tests | ✓ | ✓ | ✓ |
| Integration tests | — | ✓ | — |
| End-to-end tests | ✓ | ✓ | — |
| Build | ✓ | ✓ | ✓ (debug APK uploaded as artefact) |
| Documentation link check | ✓ | ✓ | ✓ |

CI ends with a job named `ci` that depends on every other job and fails if any of them failed, was cancelled or was skipped. Branch protection requires only `ci` (section 3.1), so jobs can be added, renamed or removed without blocking pull requests: every job must be listed in the needs of `ci`, and `ci` is never renamed or removed. The skeleton's CLAUDE.md states this rule.

CI must stay under 10 minutes; the Architect splits or optimises it when it grows. CI results are fed back to agents through `ci.status` and the submission flow (05, section 4.9), so failures must print a readable reason.

## 5. Conventions

| Topic | Rule |
|---|---|
| Commits | Conventional Commits, with the ticket number: `feat(WEB-12): add contact form`. |
| Branches | `t/<number>-<slug>` (04, section 4). |
| Pull requests | Template with summary, ticket link, acceptance criteria checklist, tests, documentation. Filled from the DoD report. |
| Changelog | One entry per merged ticket with a user-visible effect, written for users. |
| Secrets | Never committed. `.env.example` lists variables; real values stay out of the repository. |
| Dependencies | Added only when needed; a new major dependency requires an ADR. |

## 6. Tickets that are ready

The Project Manager only proposes tickets that meet the **Definition of Ready**; `plan.propose` validates what can be checked mechanically.

- A title that says what changes for the user or the system.
- Acceptance criteria that can each be verified by a test or by reading the documentation.
- Small enough for one run: as a guide, one feature slice, touching one area of the code.
- A type, an assignee and dependencies.
- No open technical question; otherwise a `spike` comes first.

## 7. Keeping the harness alive

- The Definition of Done (04, section 3) makes tests and documentation part of every ticket.
- The Quality agent checks CLAUDE.md size, documentation quality and ADR compliance at every review.
- A **harness check** can be scheduled per project (setting, off by default to save quota): the Architect runs a `chore` ticket that verifies CLAUDE.md is accurate, CI is green on the default branch, documentation links work, and dependencies have no known critical vulnerability. Findings become tickets.

## 8. The Orchestrator's own harness

The Orchestrator is developed with Claude Code under the same rules:

- same repository layout, with these specs in `docs/specs/`;
- its user documentation in `docs/user/`, displayed in the application's Help section;
- default agent instructions in `agents/` (03, section 6);
- every feature delivered with its user documentation, so the owner can use the tool without reading its code.

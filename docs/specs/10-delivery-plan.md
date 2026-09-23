# 10 — Delivery Plan

> Status: Draft v0.1
> Related: all specs

The Orchestrator is delivered in lots. Each lot ends with something the owner can use, with its user documentation, following the harness (08). Lots are ordered so that the tool can start building itself as early as possible.

## Overview

| Lot | Name | Usable result |
|---|---|---|
| 0 | Foundations | Repository with harness, running container, setup wizard, Help section. Spike results recorded. |
| 1 | Projects and tickets | A working ticket tracker linked to GitHub. |
| 2 | Machines and manual runs | An agent works on a ticket when the owner starts it, with live logs and questions. |
| 3 | Full ticket lifecycle | Submission, pull request, CI, review by Quality, merge detection. |
| 4 | Scheduler and quota | Tickets run automatically within windows and budget; quota pauses and resumes. |
| 5 | Requests and planning | The owner describes what they want; the Project Manager plans; new projects are bootstrapped. |
| 6 | Agent management | Custom agents, profile editing, Technical Writer, Android projects. |
| 7 | Hardening | Deployment guides, backups, harness checks, resilience. |

Lots 0 to 3 are built by the owner with Claude Code directly. From lot 4 the Orchestrator can take tickets for its own development, and from lot 5 new features can be requested through it.

## Lot 0 — Foundations

**Scope**

- Spike on Claude Code behaviour (05, section 9): **done**, see ADR 0002. Remaining: capture the usage-limit signal when it happens.
- Monorepo structure (09, section 2), lint, format, type check, tests, CI.
- CLAUDE.md, `docs/` layout, ADRs for every choice in 09, section 3.
- Docker Compose with the server and PostgreSQL, migrations at start, `/health`, `/version`.
- Owner account and login; setup wizard steps 1 and 2 (account, GitHub token).
- Help section rendering `docs/user/`.

**Done when** the owner can start the stack on WSL, create the account, connect GitHub and read the getting started guide in the application.

## Lot 1 — Projects and tickets

**Scope**

- Projects: create with a new GitHub repository and the skeleton (08, section 3.1) or by linking an existing repository (08, section 3.4), list, archive, settings.
- Tickets: create, edit, board, detail, comments, dependencies, manual status changes restricted to owner transitions (cancel, mark as done manually, reopen; 04, section 2).
- Settings screen with limits (04, section 8).
- Event log.

**Done when** the owner can manage a project's tickets entirely from the UI and the repository is created with the skeleton.

## Lot 2 — Machines and manual runs

**Scope**

- Claude accounts and machines screens; enrollment (05, section 3).
- Daemon: connection, heartbeat, `login` (dedicated Claude configuration), workspace trust per repository, `doctor`, `status`, `attach`, systemd service.
- Run execution (05, section 4) for purpose `implement`, started manually with **Run now**.
- Permission enforcement through hooks.
- MCP relay and tools: reading tools, `ticket.progress`, `ticket.comment`, `ticket.ask`, `ticket.give_up`.
- Live logs and questions in the UI; "Needs you" with questions.
- Default profiles for Architect and Web Developer, with their allowlist smoke tests.

**Done when** the owner starts a run on a ticket, watches it live, answers a question, and finds the agent's commits on a local branch.

## Lot 3 — Full ticket lifecycle

**Scope**

- `ticket.submit` with DoD report; push by the daemon; pull request creation.
- CI polling, `ci.status`, CI results sent back to the session.
- Quality profile, review runs, `review.approve`, `review.request_changes`, `fix_review` runs.
- Merge detection, `done` state; "Needs you" with pull requests to merge.
- Failure handling and retry policy (04, section 5).

**Done when** a ticket goes from `todo` to `done` with a reviewed, merged pull request, without the owner touching Git.

## Lot 4 — Scheduler and quota

**Scope**

- Scheduling loop, priority order, machine selection (07, sections 2 to 4).
- Quota detection, `paused_quota`, account `limited` state, resume (07, section 5.2).
- Schedule windows, daily budget, manual pause.
- Activity screen: queue and reasons.
- Daemon reconciliation after disconnection (05, section 6).

**Done when** the owner leaves the system running overnight and finds the eligible tickets processed, with quota limits handled without repeated failures.

## Lot 5 — Requests and planning

**Scope**

- Requests screens, planning runs, `request.ask`, `plan.propose` with validation.
- Plan review screen with dependency graph, approve, reject with feedback, edit before approving.
- Project Manager profile.
- Project creation from an approved plan, with the bootstrap ticket (08, section 3.2).
- Setup wizard steps 3 to 5.

**Done when** the owner submits "a simple website with a contact form" and, after approving the plan and merging pull requests, gets a working website with CI, tests and documentation.

## Lot 6 — Agent management

**Scope**

- Agents screens: list, editor, preview, versions, reset, custom agents (03, section 5).
- Technical Writer profile and `docs` flow.
- Android Developer profile, `android-sdk` capability, Android CI with APK artefact.
- Assignment validation rules (03, section 4).

**Done when** the owner creates a custom agent and uses it on a ticket, and an Android project builds its APK in CI.

## Lot 7 — Hardening

**Scope**

- Deployment guides for Unraid and VPS, reverse proxy and VPN notes.
- Backup and restore command and guide.
- Harness check tickets (08, section 7).
- Browser notifications.
- Secret masking in transcripts, audit of permissions, dependency audit in CI.
- Trust the forwarded client address from a configured reverse proxy, for login throttling (see ADR 0015).

**Done when** the Orchestrator runs on its final host with backups, and the user documentation covers installation to daily use.

## Rules for every lot

- User documentation for every feature of the lot is part of the lot.
- Specs are updated in the same pull request when implementation reveals they were wrong.
- A lot is closed only when its "done when" scenario has been run by the owner, following the user documentation alone.

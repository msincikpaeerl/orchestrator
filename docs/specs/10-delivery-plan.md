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
| 6 | Isolated agent workspace | Agents work on a machine or environment of their own, with Docker, databases and servers, away from the owner's files. |
| 7 | Agent management | Custom agents, profile editing, Technical Writer, Android projects. |
| 8 | Hardening | Deployment guides, backups, harness checks, resilience. |

Lot N is released as version 0.(N+1).0: lot 0 is 0.1.0, lot 1 is 0.2.0, lot 2 is 0.3.0, and so on (owner's decision, lot 1 step G). Lot 6, Isolated agent workspace, was added by the owner in lot 5 step A: Agent management became lot 7 (0.8.0) and Hardening lot 8 (0.9.0). Closed lot plans keep their old numbers as records; every spec says the new ones. Screens refer to features of later lots by that version ("Used from version 0.3.0").

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
- Run execution (05, section 4) for purpose `implement`, started manually with **Run now**; the run is cancelled if the daemon does not acknowledge it within the dispatch acknowledgement timeout (07, section 8). **Stop run** by the owner.
- A reduced `ticket.submit`: the report is stored and the ticket goes to `in_review`, meaning "work finished, the owner checks it", with no push, pull request, CI or Quality (04, sections 1 and 3.1).
- Usage limits: detection in one daemon module, runs paused for a detected or suspected limit, account `limited` only for a detected one, **Resume** by the owner (05 section 4.10, 07 section 5.2). The real signal is captured by the owner if the limit happens before the lot check; otherwise the capture moves to lot 4.
- Permission enforcement through hooks.
- MCP relay and tools: reading tools (except `ci.status`, lot 3, and `request.get`, lot 5), `ticket.progress`, `ticket.comment`, `ticket.ask`, `ticket.give_up`, `ticket.create` (limited per run, 04 section 8; the ticket is `proposed` until the owner accepts or rejects it).
- Live logs and questions in the UI through the Server-Sent Events stream; "Needs you" with questions, tickets proposed by agents, finished work to check, paused runs, missing account or machine.
- Ticket assignee, branch (on the machine) and commits, attempt count, runs on the ticket page; Activity > Live runs and History.
- Default profiles for Architect and Web Developer, with their allowlist smoke tests.

**Done when** the owner starts a run on a ticket, watches it live, answers a question, and finds the agent's commits on a local branch.

## Lot 3 — Full ticket lifecycle

**Scope**

- `ticket.submit` with DoD report; push by the daemon; pull request creation.
- CI polling, `ci.status`, CI results sent back to the session.
- Quality profile, review runs, `review.approve`, `review.request_changes`, `fix_review` runs.
- Merge detection, `done` state; "Needs you" with pull requests to merge.
- Failure handling and retry policy (04, section 5).
- Decide whether the owner's **Request changes** from `in_review` (added in lot 2 step L2, 04 section 2) stays once Quality reviews `in_review` tickets. *Decided in lot 3 step A*: it stays while no review run is active, and its next run is `fix_review` with the owner's comment as the point; reviews are started by the owner (**Start review**) or skipped (**Skip review**) until lot 4 (04 section 2, 07 section 3).
- Protocol version 2 and the daemon's build identifier, with "Update the daemon" in Help (05 sections 2 and 3.3).

**Done when** a ticket goes from `todo` to `done` with a reviewed, merged pull request, without the owner touching Git.

## Lot 4 — Scheduler and quota

**Scope**

- Scheduling loop, priority order, machine selection (07, sections 2 to 4).
- Automatic resume of paused runs and the doubling fallback delay (07, section 5.2); detection, `paused_quota` and `limited` exist since lot 2. The usage-limit signal capture, if lot 2 could not do it: in lot 4 only if the limit is reached during the lot, otherwise moved to Hardening, lot 8 (owner's answer 12, lot 4 step A).
- Schedule windows, daily budget, manual pause: **Stop new runs** and **Resume**; **Pause now** and the pause at a window's end are kept for later (07, sections 5.3 and 5.5): they need a daemon command, and lot 4 raises no protocol version (owner's answer 7, lot 4 step A).
- Activity screen: queue and reasons.
- Daemon reconciliation after disconnection (05, section 6).
- From lot 3 (owner's decision, lot 3 step A): a failure that is not counted as an attempt (`ci_timeout`, `push_failed`, `download_failed`, a review run that did not finish) leaves a blocking "Needs you" item, so the scheduler never retries it in a loop. Decided in lot 4 step A: reviews and fixes start by themselves, with a per-project switch on by default (answer 1); a run waiting for CI still counts against its account's maximum (answer 2); `ci_cancelled` also leaves a blocking item, and a failure the machine caused leaves the machine out until something changes (answer 3; 07, section 4); agents under a separate system user stay in Hardening, lot 8 (answer 11).
- Carried from lot 3's check (lot 3 plan, "Carried to lot 4"; each placed in a step of `docs/dev/lot-4-plan.md`, or left out there with its reason): A27 in the GitHub smoke test (a pull request title of 256 characters and a description of 65,536); **Push again** for a refused push, without a session (moved to lot 8, Hardening, answer 8); acceptance criteria numbered from 0 in agent-written texts while the owner sees them from 1 (agents write them from 1 in the owner's texts, the tool keeps 0 until a daemon update, answer 13); the owner's **Request changes** contradicting an acceptance criterion (answer 14).

**Done when** the owner leaves the system running overnight and finds the eligible tickets processed, with quota limits handled without repeated failures.

## Lot 5 — Requests and planning

**Scope**

- Requests screens, planning runs, `request.ask`, `plan.propose` with validation.
- Plan review screen with dependency graph, approve, reject with feedback, edit before approving.
- The same dependency graph on the project board (02, section 6.3). Until then, the ticket page lists "Blocked by" and "Blocks" and the board shows a "Blocked" badge.
- Project Manager profile.
- Project creation from an approved plan, with the bootstrap ticket (08, section 3.2).
- Setup wizard steps 3 to 5.
- Carried from lot 4's check (lot 4 plan, "Carried to lot 5"): the usage-limit signal capture, an open point of lot 5's plan, done by the owner if the limit is reached during the lot.
- Decided in lot 5 step A (owner's answers; `docs/dev/lot-5-plan.md`): protocol version 3, with planning runs in a scratch folder (new project) or a worktree detached at the base branch (existing project), and acceptance criteria numbered from 1 in `ticket_submit` (answer 1; 05, section 4.2); browser tests on the machine: the owner installs Playwright's system libraries once, browsers download into the daemon's folder, `doctor` checks them and the machine reports the capability `browser-tests`, which new `website` and `web_app` projects require (answer 5; 05 sections 4.2 and 8); `plan.propose` refuses assignees and kinds that come with lot 7 (answer 7); the bootstrap ticket's fixed criteria added by the server (answer 8); the project's name, key, repository and visibility set at approval (answer 9); planning failures stop a request after **Failed attempts before asking you** (answer 10); the graph drawn without a new dependency (answer 14); **Skip for now** on the wizard's machine step (answer 15). Parent tickets (epics, 01 section 3.4) are left out, for later (answer 13).

**Done when** the owner submits "a simple website with a contact form" and, after approving the plan and merging pull requests, gets a working website with CI, tests and documentation. Made testable in lot 5's plan ("What the website must be"; owner's answers 2 to 4, lot 5 step A): the owner submits a fixed request text; the form's name, e-mail address and message are checked in the browser and by the site's server, an accepted message is saved as one line in a file kept out of Git and the visitor sees a confirmation, no e-mail is sent; the owner runs the site locally from its getting started guide alone (no deployment in v1); its CI runs lint, format and type checks, unit and end-to-end tests, the build and the documentation link check, green on `main`; its README, CLAUDE.md, user guide, developer documentation, ADRs and CHANGELOG exist.

## Lot 6 — Isolated agent workspace

Added by the owner in lot 5 step A. Its steps are planned when the lot starts.

**Scope**

- The daemon runs agents' sessions on a machine or an environment dedicated to agents, with no access to the owner's personal files or credentials (the owner's GitHub and Claude credentials, home folder, other projects): the main target is a dedicated Linux machine (the owner has one); a dedicated WSL distribution is the fallback on a Windows host.
- There agents may use Docker, install packages, run servers and search the web for integration research, which the rules of 05 section 4.6 forbid on the owner's own user (container tools denied, paths outside the worktree refused).
- What it unlocks: a `web_app` with PostgreSQL (08, section 3.3) whose integration tests run locally, not only in CI; heavier stacks needing services or containers; browser tests without the owner's system libraries; the separation the separate system user of lot 8 was meant to give, on machines dedicated to agents.

**Done when** to be written with the lot's plan.

## Lot 7 — Agent management

**Scope**

- Agents screens: list, editor, preview, versions, reset, custom agents (03, section 5).
- Technical Writer profile and `docs` flow.
- Android Developer profile, `android-sdk` capability, Android CI with APK artefact.
- Assignment validation rules (03, section 4).

**Done when** the owner creates a custom agent and uses it on a ticket, and an Android project builds its APK in CI.

## Lot 8 — Hardening

**Scope**

- Deployment guides for a dedicated server (the Orchestrator's future host) and a VPS, reverse proxy and VPN notes.
- Backup and restore command and guide.
- Harness check tickets (08, section 7).
- Browser notifications.
- Secret masking in transcripts, audit of permissions, dependency audit in CI.
- Agents run under a separate system user from the daemon (05, section 7.2): today an agent runs as the daemon's user, so it can read the daemon's machine token and ask the server for the GitHub credential of an active run. It stays here (owner's answer 11, lot 4 step A), for machines shared with the owner; lot 6's isolated workspace is the answer for machines dedicated to agents.
- **Push again** for a push GitHub refused, without a session, with the design of lot 3's plan ("Carried to lot 4"; owner's answer 8, lot 4 step A). It needs a daemon command, so a raise of the protocol version; `ticket_submit`'s criteria counted from 1 came earlier, with lot 5's protocol 3 (owner's answer 1, lot 5 step A).
- **A run whose `state.json` the daemon cannot read** (found in lot 4 step G; owner's answer, review of step G): the same daemon update removes its worktree (or reports it in `hello`), so the next run of its ticket on that machine no longer fails its preparation with "checked out by another run" (05, section 6, a known limit until then).
- The usage-limit signal capture, if neither lot 4 nor lot 5 reached the limit (owner's answer 12, lot 4 step A; carried to lot 5 first by the owner, lot 4 step L).
- Lot 4 and lot 5 step A called this lot "lot 7"; it became lot 8 when lot 6 was added. Its daemon items (**Push again**, the unreadable `state.json`) stay here (owner's answer 1, lot 5 step A); criteria numbered from 1 in the tool moved to lot 5's protocol 3.
- Trust the forwarded client address from a configured reverse proxy, for login throttling (see ADR 0015).
- Point to settle: whether the server's shutdown forces busy HTTP connections closed after a grace period. Since lot 2 step L1, SIGTERM ends the realtime streams at once and the server exits in milliseconds, but a response still being sent (for example a daemon package download the client stops reading) keeps the close waiting until Docker kills the process, 10 seconds by default; PostgreSQL rolls back any write interrupted by the kill. Left unchanged in lot 2 (owner's decision, review of step L1).

**Done when** the Orchestrator runs on its final host with backups, and the user documentation covers installation to daily use.

## Rules for every lot

- User documentation for every feature of the lot is part of the lot.
- Specs are updated in the same pull request when implementation reveals they were wrong.
- A lot is closed only when its "done when" scenario has been run by the owner, following the user documentation alone.

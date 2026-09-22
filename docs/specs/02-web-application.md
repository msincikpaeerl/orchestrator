# 02 — Web Application: Functional Specification

> Status: Draft v0.1
> Related: [01 — Domain Model](01-domain-model.md), [03 — Agents](03-agents.md), [04 — Ticket Lifecycle](04-ticket-lifecycle.md), [07 — Scheduler](07-scheduler.md)

This document describes the screens of the web application and what the owner can do on each. It describes behaviour, not visual design.

## 1. General rules

- **Responsive.** Every screen works on a phone, so the owner can answer questions and approve plans away from the computer. Complex editing (agent instructions) may be more comfortable on desktop but must remain possible on mobile.
- **Live.** Screens update in real time (ticket changes, run logs, new questions) without reloading.
- **Help everywhere.** Each screen has a help link to the matching page of the user documentation.
- **English only** for all text.
- **Confirmation** for destructive actions (cancel ticket, revoke machine, delete agent).
- **Notifications**: a badge on "Needs you" and optional browser notifications for new questions, plans to approve and pull requests to merge.

## 2. Navigation

| Section | Purpose |
|---|---|
| Needs you | Home page: everything waiting for the owner. |
| Requests | Talk to the Project Manager. |
| Projects | Project list, board, tickets. |
| Activity | Live and past runs, event log. |
| Agents | Default and custom agent profiles. |
| Machines | Machines and Claude accounts. |
| Settings | Global settings, GitHub connection, owner account. |
| Help | User documentation. |

## 3. First launch: setup wizard

Shown on first launch until completed. Each step links to its help page.

The wizard covers only the steps that exist in the current version and ends on a **Done** page linking to Help. Steps added by later versions are not forced through the wizard again: until they are done, they appear as items in "Needs you" (for example "No machine connected yet") with a link to the right screen.

1. **Create the owner account**: username and password (at least 12 characters). See 01, section 3.11.
2. **Connect GitHub**: paste a fine-grained personal access token; the application checks it, shows its expiry date and lists the permissions it still needs (section 3.1).
3. **Add a Claude account**: label, plan, optional schedule windows and daily budget. *(Lot 2.)*
4. **Add a machine**: name, account; shows the install and enrollment commands and waits until the daemon connects and passes its checks. *(Lot 2.)*
5. **Done**: links to Help; once requests exist, suggests submitting a first request.

### 3.1 GitHub token requirements

A fine-grained personal access token with:

| Setting | Value | Why |
|---|---|---|
| Repository access | All repositories | Repositories created later by the Orchestrator must be covered. |
| Administration | Read and write | Create repositories, apply branch protection. |
| Contents | Read and write | Skeleton commits, branches. |
| Pull requests | Read and write | Open pull requests, post review comments, detect merges. |
| Workflows | Read and write | The skeleton and agents commit `.github/workflows` files; GitHub rejects them without it. |
| Checks | Read | GitHub Actions results are check runs. |
| Commit statuses | Read | CI status reported as commit statuses. |
| Actions | Read | Failed job logs for `ci.status` (06). |
| Metadata | Read | Required by GitHub for any repository access. |

The wizard and Settings show the token's expiry date. "Needs you" warns 14 days before it expires (the delay is a setting).

## 4. Needs you

The owner's task list, ordered by age:

- plans to approve or reject;
- questions from agents (tickets and requests), answerable inline;
- pull requests awaiting merge, with a link to GitHub and the review summary;
- tickets stopped after repeated failures;
- system problems: machine offline with active work, account limited, daemon incompatible;
- setup still to do: steps added after the owner went through the wizard (section 3), for example "No machine connected yet";
- GitHub token expiring within 14 days, expired, or missing permissions (section 3.1).

Also shows a compact status line per Claude account (available, limited until, paused, next window).

## 5. Requests

### 5.1 Request list

Open and closed requests, with their status and project.

### 5.2 New request

- Free text, optionally attached to an existing project (otherwise the Project Manager may propose a new project).
- Submitting creates the request and a planning run is scheduled (07, section 1).

### 5.3 Request detail

- The conversation with the Project Manager (clarifying questions and answers).
- The proposed plan, when available:
  - summary and new project details, if any;
  - tickets as a list and as a dependency graph, each with type, assignee and acceptance criteria;
  - actions: **Approve**, **Reject with feedback**, and edit a ticket before approving (title, criteria, assignee, dependencies).
- History of superseded plans.

## 6. Projects

### 6.1 Project list

Name, kind, repository link, counts of tickets per state, last activity. Action: archive.

### 6.2 Project board

- Columns by state (04, section 1); `proposed` hidden by default, `done` and `cancelled` collapsed.
- Cards show number, title, type, assignee, blocked indicator, active run indicator.
- Filters: type, assignee, text. Toggle to show the dependency graph.
- Actions: create a ticket manually, open project settings.

### 6.3 Ticket detail

- Header: number, title, type, status, priority, assignee, links to branch and pull request.
- Description and acceptance criteria.
- Dependencies: blocked by, blocks.
- DoD report of the latest submission, with each check's result.
- Timeline: comments, questions and answers, status changes, reviews, runs.
- Runs: list with purpose, machine, duration (working and waiting), outcome; open a run to see its live or recorded log.
- Actions depending on state: edit (in `proposed` or `todo`), change assignee, **Run now**, answer a question, request changes (in `awaiting_merge`), cancel.

### 6.4 Project settings

Name, description, required capabilities, per-project overrides of settings (04, section 8), harness check schedule (08, section 7).

## 7. Activity

- **Live runs**: what each agent is doing now: ticket, last progress line, live log from the transcript, elapsed time. Actions: stop run, attach command (for `orchestrator-daemon attach`).
- **Queue**: next candidates and why they are not running (07, section 7).
- **History**: past runs with filters (project, agent, outcome, date).
- **Event log**: filterable list of events.

## 8. Agents

### 8.1 Agent list

Default and custom profiles with role, model, version, and usage (runs, success rate).

### 8.2 Agent detail and editor

- Fields listed in 03, section 5.
- **Preview**: the full run instructions for a sample ticket.
- Version history with differences between versions.
- Actions: duplicate, reset to default (default profiles), delete (custom profiles without active runs).

### 8.3 New agent

Choose a role or duplicate an existing profile, then edit (03, section 5).

## 9. Machines

### 9.1 Claude accounts

State, plan, schedule windows, daily budget, behaviour at window end, limit history. Actions: pause (stop new runs or pause now), resume, edit.

### 9.2 Machine list and detail

- Name, OS, account, status, last heartbeat, daemon and Claude Code versions, capabilities, active runs.
- Actions: add machine (shows install and enrollment commands), disable, revoke token, edit capabilities.
- Diagnostic information reported by `doctor`.

## 10. Settings

- Global limits and scheduler settings (04, section 8; 07, section 8).
- GitHub connection: token status, expiry date, permissions check, replace token.
- Owner account: change password, sessions.
- Backup reminder with a link to the backup guide.

## 11. Help

- The Orchestrator's `docs/user/` rendered with navigation and search.
- Contextual links from every screen to the matching page.

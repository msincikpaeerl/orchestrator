# 02 — Web Application: Functional Specification

> Status: Draft v0.1
> Related: [01 — Domain Model](01-domain-model.md), [03 — Agents](03-agents.md), [04 — Ticket Lifecycle](04-ticket-lifecycle.md), [07 — Scheduler](07-scheduler.md)

This document describes the screens of the web application and what the owner can do on each. It describes behaviour, not visual design.

## 1. General rules

- **Responsive.** Every screen works on a phone, so the owner can answer questions and approve plans away from the computer. Complex editing (agent instructions) may be more comfortable on desktop but must remain possible on mobile.
- **Live.** Screens update in real time (ticket changes, run logs, new questions) without reloading. The server keeps one Server-Sent Events stream per logged-in browser (09, section 4) carrying "changed" messages (kind of entity, id, project) and, for run logs, a notice that a run has new log entries up to a given entry number; the screen then reloads what changed, and fetches a run's entries after the last one it holds, so nothing is lost across a reconnection (owner's decision, lot 2 step L). Screens also reload everything after the stream reconnects, after each action and when the window regains focus. The stream sends a keep-alive every 20 seconds and asks the browser to reconnect after 3 seconds (code constants, 04 section 8). Logging out closes the stream. The project page's polling during a repository setup, and its `projectSetupPollSeconds` setting, are removed in favour of the stream (owner's decision, lot 2 step A).
- **Help everywhere.** Each screen has a help link to the matching page of the user documentation.
- **English only** for all text.
- **Confirmation** for destructive actions (cancel ticket, mark as done manually, archive project, revoke machine, delete agent).
- **Markdown** in descriptions and comments is rendered sanitized: it can never run a script (01, section 3.5).
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

The wizard covers only the steps that exist in the current version and ends on a **Done** page linking to Help. Steps added by later versions are not forced through the wizard again: until they are done, they appear as items in "Needs you" (for example "No machine enrolled yet") with a link to the right screen.

1. **Create the owner account**: username and password (at least 12 characters). See 01, section 3.11.
2. **Connect GitHub**: a "Create the token on GitHub" button opens GitHub's token form with the name, expiry and permissions already filled in (section 3.1). The owner pastes the token and enters its expiry date, or chooses "No expiry date"; the application checks the token and shows the result of each permission (section 3.2).
3. **Add a Claude account**: label, plan, optional schedule windows and daily budget. *(Version 0.6.0, lot 5.)*
4. **Add a machine**: name, account; shows the install and enrollment commands and waits until the daemon connects and passes its checks. *(Version 0.6.0, lot 5.)*

Before these wizard steps exist, accounts and machines are added from Machines (section 9), and "Needs you" shows "No Claude account yet" and "No machine enrolled yet" until they are (owner's decision, lot 2 step A; 10, lot 5).
5. **Done**: links to Help; once requests exist, suggests submitting a first request.

### 3.1 GitHub token requirements

A fine-grained personal access token whose resource owner is the owner's **personal GitHub account** (a fine-grained token covers a single account or organization; organizations are not supported in v1), with:

| Setting | Value | Why |
|---|---|---|
| Repository access | All repositories | Repositories created later by the Orchestrator must be covered. |
| Administration | Read and write | Create repositories, apply branch protection (08, section 3.1). |
| Contents | Read and write | Skeleton commit, branches; read the files of a linked repository to find missing harness elements (08, section 3.4). |
| Pull requests | Read and write | Open pull requests, post review comments, detect merges. |
| Workflows | Read and write (GitHub offers only this level) | The skeleton and agents commit `.github/workflows` files; GitHub rejects them without it. |
| Commit statuses | Read | CI status reported as commit statuses. |
| Actions | Read | GitHub Actions results for `ci.status` (06): workflow runs, jobs and failed job logs. |
| Metadata | Read | Required by GitHub for any repository access; GitHub adds it automatically. Lists the owner's repositories that can be linked to a project. |

Fine-grained tokens cannot use GitHub's Checks API and have no Checks permission, so CI results come from the Actions permission.

The "Create the token on GitHub" link pre-fills the token name, a one-year expiry and the permissions above, using GitHub's URL parameters for fine-grained tokens. The link cannot select "All repositories": the wizard tells the owner to choose it. The user documentation recommends keeping an expiry date (for example one year).

**Expiry date.** GitHub has no documented way to read a fine-grained token's expiry date, and a token may have none. The owner enters the date GitHub showed when creating the token, or chooses "No expiry date". The field is pre-filled from GitHub's `GitHub-Authentication-Token-Expiration` response header only when it gives a plausible date: in the future and at most 366 days ahead. The wizard and Settings show the stored date; "Needs you" warns 14 days before it (the delay is a setting). A token with no expiry date gets no expiry warning.

### 3.2 Token check

GitHub has no way to list the permissions of a fine-grained token, so the application tries requests with it ([ADR 0022](../adr/0022-github-token-verification-confirmed.md)). The check never creates or changes anything on GitHub:

1. The token is valid: `GET /user` succeeds. This gives the account name shown to the owner. The account's login and numeric id are stored with the token when it is saved (not read again at every run): they give the address of agent commits (04, section 4). A token saved before version 0.3.0 gets them at its next check or first use. A classic token (not starting with `github_pat_`) is refused.
2. Read permissions (Metadata, Actions, Commit statuses), with read requests on one existing private repository of the owner, when there is one.
3. Write permissions (Administration, Contents, Pull requests, Workflows), with deliberately invalid requests: GitHub answers "validation failed" when the permission is granted and "not accessible" when it is missing (confirmed with the real GitHub in lot 0 step E).
4. A probe that depends on another permission is sent only when that permission is OK: GitHub refuses a workflow file without Contents write before looking at Workflows. Otherwise the result is **Could not verify** with the reason (for example "Requires Contents (Read and write) first"), never **Missing**.

When GitHub refuses a request and sends the `X-Accepted-GitHub-Permissions` header, the permissions it names are used. Each permission shows one of **OK**, **Missing** or **Could not verify** (for example: no repository to test on, GitHub unreachable, or an answer the check does not recognise). The check never guesses.

The check is a convenience. The safety net is normal operation: any request GitHub refuses because the token is invalid or a permission is missing creates a "Needs you" item naming the problem or the permission (section 4), whatever the stored expiry date says.

## 4. Needs you

The owner's task list, ordered by age:

- plans to approve or reject;
- questions from agents (tickets and requests), answerable inline;
- tickets proposed by agents (`ticket.create`), each with **Accept** and **Reject**;
- work finished by an agent and waiting for the owner's check (lot 2: tickets in `in_review`, see 04 section 1), with the run's summary, **Mark as done manually** and **Request changes** (a required comment; the ticket returns to `todo`, 04 section 2); once **Request changes** succeeds, its confirmation offers **Run now** directly (the usual action, with its usual refusals) (owner's decision, lot 2 step L2);
- runs paused by a usage limit ("Claude usage limit reached: you can resume after <time>", with "estimated" next to the time when it comes from the fallback delay, 07 section 5.2) or a suspected one ("Run paused: possible Claude usage limit", with the note "the run may pause again if it was the limit"), with **Resume** (for a detected limit, only after that time; for a suspected one, at once) and **Stop run**. Before lot 4 nothing resumes by itself (owner's decision, lot 2 step L2);
- pull requests awaiting merge, with a link to GitHub and the review summary;
- tickets stopped after repeated failures;
- system problems: machine offline with active work, account limited, daemon incompatible (its protocol version is refused, with the update instruction: the server's install command, then restarting the daemon, 05 section 2), Claude Code version not supported (missing or below the minimum), machine with a problem found by `doctor` (a check reporting an error). The last two make the machine unusable (01, section 3.8); warnings found by `doctor` are shown only on the machine page (owner's decision, lot 2 step C). A limited account is not an item of its own: the account status line below shows it, a run it paused is listed above, and **Run now** says why it refuses, with the time (owner's decision, lot 2 step L2);
- setup still to do: steps added after the owner went through the wizard (section 3): "No Claude account yet" while no account exists, "No machine enrolled yet" while no machine is enrolled and not revoked (a machine that enrolled and is now offline does not bring it back; owner's decision, lot 2 step C);
- GitHub token expiring within 14 days or expired (by its stored date), rejected by GitHub as invalid, missing a permission (sections 3.1 and 3.2), or unreadable because `ORCHESTRATOR_SECRET_KEY` changed (enter the token again).

Also shows a compact status line per Claude account (available, limited until, paused, next window). In lot 2 it reads "Available" or "Limited until <time>"; a limit whose time has passed shows "Available"; a manually paused account (lot 4) shows "Paused"; the next window comes with lot 4 (owner's decision, lot 2 step L).

A question is answered with the same answer box on "Needs you", the ticket page and the run page (section 7).

Items are ordered by the time their reason began: a question when it was asked, a proposed ticket when it was created, finished work when it was submitted, a paused run when it paused (owner's decision, lot 2 step L2).

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

Key, name, kind, repository link (with "private" or "public"), counts of tickets per state, last activity. Archived projects are hidden behind a "Show archived" toggle. Actions: new project, archive, unarchive.

Archiving asks for confirmation and says what happens: the project and its tickets are kept and read-only, no new work starts, and the GitHub repository is not changed.

### 6.2 New project

The owner chooses one of two ways:

- **Create a new repository**: name, key, kind, description, and visibility (**private** by default, public can be chosen). The repository name is the slug of the name and can be edited; the form checks it is free on the owner's account. The Orchestrator creates the repository with the skeleton (08, section 3.1).
- **Link an existing repository**: pick one of the owner's repositories (from their personal account, not archived, not already linked), then name, key, kind and description. Nothing is written to the repository; the Orchestrator lists the harness elements it is missing (08, section 3.4).

The key (2 to 6 uppercase letters) is suggested from the name and can be edited; the form explains that it prefixes ticket numbers and cannot be changed later.

The project page shows the repository setup while it runs (refreshing on its own, section 1) and its result. If it fails (for example GitHub refused a request), the reason is shown with a **Try again** action, and "Needs you" lists the project until it is ready.

### 6.3 Project board

- Header: key, name, repository link, setup status, branch protection status (applied, or not available on the owner's GitHub plan, with a help link), and for a linked repository the missing harness elements with **Check again**.
- Columns by state (04, section 1); `done` and `cancelled` collapsed. `proposed` is hidden by default, except that tickets proposed by agents (no plan) are shown in a "Proposed" column whenever there is at least one (owner's decision, lot 2 step A); the toggle for plan tickets comes with lot 5.
- On a wide screen the columns sit side by side; on a phone they are stacked one below the other, each with its ticket count, so nothing scrolls sideways (owner's decision, lot 1 step F).
- Cards show number, title, type, assignee, a "Blocked" badge (only for `proposed` and `todo` tickets, 04 section 1), "created by agent" when an agent created it, active run indicator with the last progress line.
- Filters: type, assignee, text. Toggle to show the dependency graph *(lot 5, with the plan review graph)*.
- Actions: create a ticket manually, open project settings.

### 6.4 Ticket detail

- Header: number, title, type, status, priority, assignee, links to branch and pull request. Until pushing exists (lot 3), the branch is shown as "on machine <name>, not on GitHub yet" with the commits the last run reported (01, section 3.4).
- Description and acceptance criteria.
- Dependencies: blocked by, blocks. Only tickets of the same project; a dependency that would create a cycle is refused with an explanation. Dependencies can be added or removed only while the waiting ticket is `proposed` or `todo`; the blocking ticket can be in any state (owner's decision, lot 1 step E).
- DoD report of the latest submission, with each check's result. In lot 2 only the report's summary and criteria are shown; the checks' results come with lot 3.
- Timeline: comments, questions and answers, status changes, reviews, runs.
- Runs: list with purpose, machine, duration (working and waiting), outcome; open a run to see its live or recorded log.
- Actions depending on state (04, section 2): edit (in `proposed` or `todo`), change assignee, **Accept** and **Reject** (a `proposed` ticket created by an agent), **Run now** (in `todo`; when it cannot start, the reason is shown: no assignee, blocked, no compatible machine online, account limited, account already running its maximum, ticket too large to send to an agent), **Stop run** (while a run is active), **Resume** (a paused run), answer a question, add a comment, **Request changes** (in `awaiting_merge`, and in lot 2 in `in_review`, with a required comment; once it succeeds, its confirmation offers **Run now** directly), cancel, **Mark as done manually** (with a mandatory comment), **Reopen** (in `cancelled`).
- **Mark as done manually** on a ticket that still waits for tickets not `done` stays allowed (04, section 2), but its confirmation warns first: it names each of those tickets with its number and state and asks to confirm anyway (**Mark as done anyway**). The API is unchanged (owner's finding, lot 1 step I).

### 6.5 Project settings

Name, description, required capabilities, per-project overrides of settings (04, section 8), harness check schedule (08, section 7). The key, the repository and the kind cannot be changed.

## 7. Activity

- **Live runs**: what each agent is doing now: every active run (01, section 3.7), those waiting for the owner or paused marked as such, with ticket, last progress line, its latest log entry (its current activity, updated live) with a link to the run page for the full log, elapsed time, estimated usage. Actions: stop run, attach command (for `orchestrator-daemon attach`) (owner's decision, lot 2 step L2).
- **Queue**: next candidates and why they are not running (07, section 7). *(Lot 4.)*
- **History**: ended runs, newest first, with filters (project, agent, outcome, date) and paging. The outcome filter is the run's end state (succeeded, failed or cancelled), and each failed run's row shows its failure reason (owner's decision, lot 2 step L2).
- **Run page**: purpose, ticket, agent and profile version, machine, status (with the pause reason), times working and waiting (01, section 3.7), estimated usage, the progress line, outcome, branch and commits, the answer box while the run waits for the owner's answer (owner's decision, lot 2 step L), and the log: one entry per transcript event (the agent's text, each tool with a short input, tool results cut to the "Longest stored log entry" setting), with credentials masked as in the event log. Logs are kept for as long as the run (owner's decision, lot 2 step A).
- **Event log**: filterable list of events, newest first, each in plain words with links to its project or ticket ("WEB-12 marked as done manually: “…”"), its time and who caused it. Filters: project (events about no project are shown only without this filter), ticket, kind of entity, event type, and a range of days. A page shows a fixed number of events, with a button for the older ones; pages follow a cursor (time and id of the last event shown), so events written meanwhile never shift them. Titles, names and comments are quoted as plain text (never Markdown or HTML), on one line and shortened, each quote linking to the page with the full text. Credentials are never shown, even if a payload held one (lot 1 step H).

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

In lot 2 an account has a label, a plan and its maximum concurrent runs, and shows its state (`available`, or `limited` until a time); schedule windows, the daily budget, the behaviour at window end and manual pause come with lot 4.

### 9.2 Machine list and detail

- Name, OS, account, status, last heartbeat, daemon and Claude Code versions, capabilities, active runs.
- Status: one label derived from the machine's fields (01, section 3.8), the first that applies in this order: **Revoked**, **Waiting for enrollment**, **Disabled** (with online or offline shown next to it), **Online**, **Offline**. An unusable machine also shows why (owner's decision, lot 2 step C).
- Capabilities: each tag shows where it comes from: detected, added by you (with a "not detected" note when the daemon does not report it), or removed by you (with a "detected" note when it does) (owner's decision, lot 2 step C).
- Actions: add machine (shows install and enrollment commands), disable and enable, revoke token (with confirmation), new enrollment code (for a machine waiting for enrollment or revoked, 01 section 3.8), edit capabilities.
- **Add machine** shows two commands: `npm install -g <server URL>/downloads/orchestrator-daemon-<version>.tgz`, which installs the daemon of the server's own version from the server itself, and `orchestrator-daemon enroll <server URL> <code>`. Then it tells the owner to run `orchestrator-daemon login` and `orchestrator-daemon install-service`, and waits until the machine connects (owner's decision, lot 2 step A; 05, section 2). When the server's address is plain `http://` and not this computer (`localhost`, `127.0.0.0/8`, `::1`), **Add machine** warns that the daemon refuses that address (05, section 3.2) and links to Help > Machines > Orchestrator on another computer (owner's decision, lot 2 step E).
- Diagnostic information reported by `doctor`.

## 10. Settings

- **Limits** (Settings > Limits): every global setting of 04 section 8, 05 section 5 and 07 section 8. Each shows its value, its default, what it does, and a **Reset to default** action. Settings that can be overridden per project say so; settings used only from a later version say "Used from version ...". Settings of a Claude account are on the account (section 9.1), not here.
- GitHub connection: token status, expiry date, permissions check, replace token.
- Owner account: change password, sessions.
- Backup reminder with a link to the backup guide.

## 11. Help

- The Orchestrator's `docs/user/` rendered with navigation and search.
- Contextual links from every screen to the matching page.

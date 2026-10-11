# 02 — Web Application: Functional Specification

> Status: Draft v0.1
> Related: [01 — Domain Model](01-domain-model.md), [03 — Agents](03-agents.md), [04 — Ticket Lifecycle](04-ticket-lifecycle.md), [07 — Scheduler](07-scheduler.md)

This document describes the screens of the web application and what the owner can do on each. It describes behaviour, not visual design.

## 1. General rules

- **Responsive.** Every screen works on a phone, so the owner can answer questions and approve plans away from the computer. Complex editing (agent instructions) may be more comfortable on desktop but must remain possible on mobile.
- **Live.** Screens update in real time (ticket changes, run logs, new questions) without reloading. The server keeps one Server-Sent Events stream per logged-in browser (09, section 4) carrying "changed" messages (kind of entity, id, project) and, for run logs, a notice that a run has new log entries up to a given entry number; the screen then reloads what changed, and fetches a run's entries after the last one it holds, so nothing is lost across a reconnection (owner's decision, lot 2 step L). Screens also reload everything each time the stream opens, the first time too (a change made between a screen's first read and the stream's opening reaches no stream; lot 3 step H5), after each action and when the window regains focus. The stream sends a keep-alive every 20 seconds and asks the browser to reconnect after 3 seconds (code constants, 04 section 8). Logging out closes the stream. The project page's polling during a repository setup, and its `projectSetupPollSeconds` setting, are removed in favour of the stream (owner's decision, lot 2 step A).
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
2. Read permissions (Metadata, Actions, Commit statuses, and from lot 3 the read side of Pull requests), with read requests on one existing private repository of the owner, when there is one (owner's decision, lot 3 step A: a read probe wherever one exists).
3. Write permissions (Administration, Contents, Pull requests, Workflows), with deliberately invalid requests: GitHub answers "validation failed" when the permission is granted and "not accessible" when it is missing (confirmed with the real GitHub in lot 0 step E).
4. A probe that depends on another permission is sent only when that permission is OK: GitHub refuses a workflow file without Contents write before looking at Workflows. Otherwise the result is **Could not verify** with the reason (for example "Requires Contents (Read and write) first"), never **Missing**.

When GitHub refuses a request and sends the `X-Accepted-GitHub-Permissions` header, the permissions it names are used. Each permission shows one of **OK**, **Missing** or **Could not verify** (for example: no repository to test on, GitHub unreachable, or an answer the check does not recognise). The check never guesses.

Lot 3 needs no new permission (owner's decision, lot 3 step A): the daemon's push uses Contents (and Workflows when a branch changes `.github/workflows/`), pull requests and their comment reviews use Pull requests, merge detection reads Pull requests, and CI reads Actions and Commit statuses. The Help page says what each permission does from 0.4.0, and links to GitHub's own page on GitHub Actions minutes for private repositories instead of giving a number that changes.

The check is a convenience. The safety net is normal operation: any request GitHub refuses because the token is invalid or a permission is missing creates a "Needs you" item naming the problem or the permission (section 4), whatever the stored expiry date says.

## 4. Needs you

The owner's task list, ordered by age:

- plans to approve or reject;
- questions from agents (tickets and requests), answerable inline;
- tickets proposed by agents (`ticket.create`), each with **Accept** and **Reject**;
- work finished by an agent and waiting for the owner's check (lot 2: tickets in `in_review`, see 04 section 1; from lot 3 step H only tickets left in `in_review` by 0.3.0 without a pull request, the others getting "Ready for review" below), with the run's summary, **Mark as done manually** and **Request changes** (a required comment; the ticket returns to `todo`, 04 section 2); once **Request changes** succeeds, its confirmation offers **Run now** directly (the usual action, with its usual refusals) (owner's decision, lot 2 step L2);
- runs paused by a usage limit ("Claude usage limit reached: you can resume after <time>", with "estimated" next to the time when it comes from the fallback delay, 07 section 5.2) or a suspected one ("Run paused: possible Claude usage limit", with the note "the run may pause again if it was the limit"), with **Resume** (for a detected limit, only after that time; for a suspected one, at once) and **Stop run**. Before lot 4 nothing resumes by itself (owner's decision, lot 2 step L2);
- pull requests awaiting merge, with a link to GitHub, the review summary (or "review skipped"), the CI result, and flags for conflicts with the base branch ("Conflicts with <base>": **Request changes** comes with a filled-in comment asking to merge the base branch and resolve them) and for changed workflow files; ordered by when the wait began (lot 3);
- tickets ready for review (`in_review` with a pull request and no review run active), with the pull request link, the CI result and the workflow flag, and **Start review** (one session) and **Skip review** (none); "Review did not finish" when a review run failed, with **Start review** (lot 3). Words (owner's answers 4 and 5, lot 3 step H): "Ready for review: BAK-12 Contact form", the pull request link, the CI line ("CI passed on GitHub for commit abc1234", "(checked again by you at 15:10)" after **Check CI again**, "No CI found for commit abc1234", or with workflow files changed "No CI found for commit abc1234, and this work changed files under .github/workflows/: it may have removed or weakened CI. Read them before reviewing or merging."), the workflow line ("Workflow files changed: …", "may have changed" when the list was cut) and "A review by Quality uses one Claude Code session; Skip review uses none."; **Start review** has no confirmation, as **Run now**; **Skip review** confirms ("Skip the review of BAK-12? It moves to Awaiting merge without Quality's review: check the pull request yourself before merging it on GitHub.", **Skip review** and **Keep it in review**) and posts the comment "The owner skipped the review.". "Review did not finish for BAK-12: Contact form": "The review run on laptop ended without a decision: <reason>. It does not count as a failed attempt." (reasons: "Quality gave up: <its reason>", "the pull request changed on GitHub during the review (now def5678)", "the branch changed on the machine during the review", and Runs' words for a timeout, a crash or a machine offline), or, when a decision was made then thrown away, which decision it was and why it was not applied (owner's answer 2, lot 3 step H4: "Quality approved commit abc1234 at 14:52, but the approval was not applied: <why>. It does not count as a failed attempt." or "Quality requested changes on commit abc1234 (3 points) at 14:52, but the request was not applied: <why>. …", the reasons "you stopped the run before it ended", "the branch changed on the machine before the run ended", "machine laptop went offline before the run ended", and Runs' words for a timeout or a crash followed by "before the run ended"; the item links to the run page, never lists the points); a head found moved by the machine before the session started reads "the pull request changed on GitHub before the review started (now def5678)" (answer 3); with **Start review** and **Skip review**. "Ready for review" is ordered by when the ticket entered `in_review`, "Review did not finish" by when the review run ended; **Start review** is the main button. After the owner's **Stop run** with no decision made, the item is plain "Ready for review" again;
- a run ended with `ci_timeout` (04, section 3.1; owner's answer 1, lot 3 step G2c), one item of three, each until the work is accepted, a new run starts, or the ticket is done or cancelled: "CI did not finish for <ticket>: <title>" (CI not finished, or nothing read), with **Check CI again**, which starts no session; when the pull request was never opened, its body says to use **Try again** in "Pull request not opened" first, then **Check CI again**; "CI failed for <ticket>, and the agent did not get the result: <title>" (a failure read only after the wait, or a round the machine did not confirm or refused), with **Run now**; "<ticket> conflicts with <base>: <title>" (a conflict not resolved), with **Run now**;
- "Pull request not opened for <ticket>" (lot 3 step F3): an accepted submission whose pull request the server could not open or update, saying why (a missing permission named "Pull requests (Read and write)" with the token list link; GitHub unreachable; no, refused or unreadable token, with a link to Settings > GitHub; GitHub's rate limit; an answer that cannot be read, with the fields that differed; any other refusal, in GitHub's masked words, a repository not found named), with **Try again** (`POST /api/projects/<key>/tickets/<number>/pull-request/try-again`, one attempt answered once made). Shown until an attempt succeeds, or the ticket is done or cancelled (04, section 3.1). When the ticket's pull request is open (as last seen), the item reads "Pull request not updated for <ticket>" ("GitHub refused to update the pull request of <ticket>"), saying its description still shows the earlier submission's report and the new commits are on GitHub, in the pull request; a closed or merged one keeps "not opened" (owner's correction, lot 3 step F4);
- "Pull request closed without merging" (closed on GitHub), with **Reopen pull request** and **Cancel ticket** (lot 3);
- tickets stopped after repeated failures (**Failed attempts before asking you**, lot 3 step K) or too many review rounds (**Most review rounds per ticket**, lot 3 step I: "Stopped after too many review rounds", "Quality requested changes 3 times, more than Most review rounds per ticket allows (2). Use Try again to let it continue, or Cancel it, or Mark it as done manually.", "Try again starts no session: the review rounds and failed attempts count from 0 again, and Run now can start the next run.", "Since <time>"), with **Try again**, **Cancel the ticket** and **Mark as done manually** (04, section 5; lot 3). **Try again** has no confirmation (it starts no session); once it succeeds, the item leaves the list and a confirmation offers **Run now** directly, with its usual refusals, as after **Request changes** (owner's answer 3, lot 3 step I2);
- a push GitHub refused (`push_failed`, or a branch that diverged on GitHub), and a GitHub write permission found missing at first use, naming it (lot 3). A `push_failed` item (lot 3 step F2) says what happened and what to do: the permission to give in the token page's words, "Contents (Read and write)" or "Workflows (Read and write)", with a link to the token list (`https://github.com/settings/personal-access-tokens`); any other refusal with GitHub's masked words; "The branch of <ticket> changed on GitHub" (the next run merges it); GitHub unreachable. It links to the ticket, where **Run now** continues the work on the machine holding it, and stays from the run's end until the next push done (an end push included), or until the ticket is cancelled or done or its machine revoked (whose commits not on GitHub are lost, 07 section 3), also while the next run works (owner's answer 4, lot 3 step F2);
- system problems: machine offline with active work, account limited, daemon incompatible (its protocol version is refused, with the update commands of Help > Machines > "Update the daemon", 05 section 2; lot 3 step B), "Update the daemon on X" (a protocol 1 daemon, unusable from lot 3), "The daemon on X is not the one this Orchestrator provides" (a different build of the same protocol, older or newer; not blocking, lot 3; 05 section 3.3), Claude Code version not supported (missing or below the minimum), machine with a problem found by `doctor` (a check reporting an error). The last two make the machine unusable (01, section 3.8); warnings found by `doctor` are shown only on the machine page (owner's decision, lot 2 step C). A limited account is not an item of its own: the account status line below shows it, a run it paused is listed above, and **Run now** says why it refuses, with the time (owner's decision, lot 2 step L2);
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
- Cards show number, title, type, assignee, a "Blocked" badge (only for `proposed` and `todo` tickets, 04 section 1), a "Stopped" badge for a ticket stopped by the retry policy (lot 3 step I2), "created by agent" when an agent created it, active run indicator with the last progress line.
- Filters: type, assignee, text. Toggle to show the dependency graph *(lot 5, with the plan review graph)*.
- Actions: create a ticket manually, open project settings.

### 6.4 Ticket detail

- Header: number, title, type, status, priority, assignee, links to branch and pull request. The branch is shown with the commits the last run reported (01, section 3.4) and where they are (lot 3 step D3): "no commits reported yet"; "on machine <name>, not on GitHub yet" (nothing pushed, the wording of 0.3.0); "every commit reported was on GitHub when machine <name> last pushed or downloaded the branch" (commits may have come from GitHub itself, such as **Update branch**); "N newer commits on machine <name>, not on GitHub yet", with the commits not on GitHub and those on GitHub in two lists, and a line for older commits beyond the report's ceiling ("N older commits are not listed here and not on GitHub either"); or, after a push refused as `diverged`, "on machine <name>, not on GitHub yet: GitHub's branch has commits this machine does not have, so the push was refused. The Orchestrator never overwrites GitHub's branch." A push done is shown as "Last pushed to GitHub on <date> from machine <name> (latest commit <hash>)" with a link to the branch on GitHub, never as a claim about GitHub now; a failed push since then as "The push to GitHub on <date> from machine <name> failed: <message>", while commits are not on GitHub; the CI result, "waiting for CI", and a "workflow files changed" note are shown with the pull request. **The CI line** (lot 3 step G2c) follows the ticket's latest run that had a CI wait (a run that ended after a confirmed round without handing in again counts), hidden while a later run works without having handed work in: waiting, passed, "No CI found" (with the workflow sentence), failed after too many failures ("The run ended after 3 CI failures (Most CI failures per run: 2)", "CI failures or conflicts" when any was a conflict), not finished, failed with the agent not getting the result, a conflict, cancelled because the branch changed ("the pull request's head is now <hash>"), and a run that ended after round N, each with what to do: **Check CI again** after `ci_timeout` without a conflict and after `ci_failed` on a failure (useful after a re-run by hand on GitHub), **Run now** otherwise (owner's answers, lot 3 step G2c). **Pull request** (lot 3 step F4): "Pull request #12 · Open" (or "Closed without merging", "Merged") linking to GitHub, the state the server saw when it last opened, updated or found it (step J reads it again), never a claim about GitHub now; "Opening the pull request on GitHub…" while an accepted submission waits for it; "Pull request not opened: <reason>" ("Pull request not updated: <reason>" when the pull request shown is open) with what to do and **Try again**, as in "Needs you" (section 4); and the workflow warning: "Workflow files changed" (a changed file under `.github/workflows/`) or "Workflow files may have changed" (the machine's list cut or not sent, or a flag kept before its reason was), each saying to look at the changed files on the pull request before merging.
- Description and acceptance criteria.
- Dependencies: blocked by, blocks. Only tickets of the same project; a dependency that would create a cycle is refused with an explanation. Dependencies can be added or removed only while the waiting ticket is `proposed` or `todo`; the blocking ticket can be in any state (owner's decision, lot 1 step E).
- DoD report of the latest submission, with each check's result (04, section 3.1). In lot 2 only the report's summary and criteria are shown. From lot 3 step F4 also the tests, documentation and ADRs listed, and **Checks**: each check with "Passed", "Failed", "Could not be fully done" or "Not checked"; a check that failed or could not be fully done says why in the owner's words, made by the screen from the reasons kept (01, section 3.7; 04, section 3.1), never with a name from the code or the agent's texts, and folds the agent's own message under "What the agent was told". Agent text (paths, justifications, messages) is shown as plain text, never HTML (the summary through `UntrustedMarkdown`, ADR 0024), credentials masked by the server as in the event log. A list longer than 10 items (`SUBMISSION_LIST_SHOWN`, a display constant) folds the rest under "Show the other N"; long paths wrap anywhere, so a phone never scrolls sideways. A report accepted before 0.4.0 says it was checked by an earlier version. A review's summary and points, and a note when posting them on GitHub failed (lot 3). Words (owner's answers, lot 3 step H): "Approved by Quality · commit abc1234 · 14:52" with the summary (untrusted text) and "Posted on GitHub" (a link) or the note "Not posted on GitHub: <reason>. The decision stands in the Orchestrator."; "Changes requested by Quality · commit abc1234 · 3 points" with each point ("src/contact.ts:42 — …"); "Review skipped by you on <date>"; "Review in progress on laptop" (a link to the run); and, when the head was not checked at the decision, "The pull request's head could not be checked on GitHub when Quality decided: check it is still abc1234 before merging." Only the latest review (or skip) is shown, earlier ones staying in the timeline; "Posting on GitHub…" while its post waits; after a review run that ended without a decision while the ticket is `in_review`, "Review did not finish: <reason>" with a link to the run (owner's answer 4, lot 3 step H4). When that latest review is about an earlier submission than the work now in review (a request for changes followed by a fix, or an approval or skip made out of date by the owner's **Request changes**), it says so: "Changes requested by Quality · commit abc1234 · 14:52, on an earlier submission. The work now in review is commit def5678 and has not been reviewed yet.", with **Start review** and **Skip review** (owner's change to answer 4). After the owner's **Request changes** on `awaiting_merge` (lot 3 step I, owner's answer 6), the approval or the skip stays shown with "You requested changes after this approval, at 15:10." (or "… after skipping the review, at 15:10.") until the fix is in review, then as a review of an earlier submission. In `todo` with a request standing: "Run now starts a run that addresses Quality's points (round 1 of at most 2)." or "Run now starts a run that addresses your request."; for Quality's request made before **Try again** or **Reopen** (its round above the ticket's review rounds) the round is left out: "Run now starts a run that addresses Quality's points." (owner's answer 4, lot 3 step I2). A ticket stopped after too many review rounds shows the stop instead: a **Stopped** badge next to the state (and on its board card, as **Blocked**), and a "Stopped" section with the words of the "Needs you" item (section 4) and **Try again**, **Cancel the ticket** and **Mark as done manually**; after **Try again**, its confirmation offers **Run now** directly (owner's answers 2 and 3, lot 3 step I2). In `awaiting_merge`, until merge detection (lot 3 step J): "Merge pull request #12 on GitHub, then use Mark as done manually: this version does not notice the merge yet." The run page of a review run has a review card: "Reviewed commit abc1234 (pull request #12)", "Decision: approved" or "Decision: changes requested (3 points)", "Decision not applied: <why>" (the reasons of "Review did not finish"), "Decision: none yet" while the run is active and "Decision: none, the run ended without one" after (owner's answer 5, lot 3 step H4), "Posted on GitHub" or the note, and the same "head not checked" sentence.
- Timeline: comments, questions and answers, status changes, reviews, runs.
- Runs: list with purpose, machine, duration (working and waiting), outcome; open a run to see its live or recorded log.
- Actions depending on state (04, section 2): edit (in `proposed` or `todo`), change assignee, **Accept** and **Reject** (a `proposed` ticket created by an agent), **Run now** (in `todo`; when it cannot start, the reason is shown: no assignee, blocked, no compatible machine online, account limited, account already running its maximum, ticket too large to send to an agent), **Stop run** (while a run is active), **Resume** (a paused run), answer a question, add a comment, **Request changes** (in `awaiting_merge`, and in `in_review` while no review run is active, with a required comment; once it succeeds, its confirmation offers **Run now** directly, which starts a `fix_review` run from lot 3), **Start review** and **Skip review** (in `in_review` with a pull request and no review run active; lot 3), **Check CI again** (after `ci_timeout` without a conflict, and after `ci_failed` on a failure, while no run is active; lot 3 steps G2b and G2c), **Try again** (a stopped ticket; lot 3), **Reopen pull request** (closed on GitHub without merging; lot 3), cancel (which closes the pull request from lot 3), **Mark as done manually** (with a mandatory comment), **Reopen** (in `cancelled`).
- **Mark as done manually** on a ticket that still waits for tickets not `done` stays allowed (04, section 2), but its confirmation warns first: it names each of those tickets with its number and state and asks to confirm anyway (**Mark as done anyway**). The API is unchanged (owner's finding, lot 1 step I).

### 6.5 Project settings

Name, description, required capabilities, per-project overrides of settings (04, section 8), harness check schedule (08, section 7). The key, the repository and the kind cannot be changed.

## 7. Activity

- **Live runs**: what each agent is doing now: every active run (01, section 3.7), those waiting for the owner or paused marked as such, with ticket, last progress line, its latest log entry (its current activity, updated live) with a link to the run page for the full log, elapsed time, estimated usage. Actions: stop run, attach command (for `orchestrator-daemon attach`) (owner's decision, lot 2 step L2).
- **Queue**: next candidates and why they are not running (07, section 7). *(Lot 4.)*
- **History**: ended runs, newest first, with filters (project, agent, outcome, date) and paging. The outcome filter is the run's end state (succeeded, failed or cancelled), and each failed run's row shows its failure reason (owner's decision, lot 2 step L2).
- **Run page**: purpose, ticket, agent and profile version, machine, status (with the pause reason, and for a failed or cancelled run the machine's own words when it gave some, `endDetail`, such as a download stopped by **Longest push**; lot 3 step D1), times working and waiting (01, section 3.7), estimated usage, the progress line, outcome, branch and commits ("on machine <name>, as this run left it") with the run's own latest push ("This run pushed it to GitHub on <date>", or why it failed; lot 3 step D3), the answer box while the run waits for the owner's answer (owner's decision, lot 2 step L), while the run waits for CI (status "Waiting for CI", also on the board card) a CI card: the submitted commit and pull request, since when and until when it waits, the latest check's time, a sentence for the pull request not opened yet, nothing appeared yet (and by when it passes as "No CI found"), GitHub still working out a conflict, or a conflict, a line when GitHub could not be checked at the latest check (since when and why, with the time GitHub allows requests again), and each workflow run and status with its state, names as plain text and links through ADR 0024's allow-list (lot 3 step G1b), and for an ended run its CI card with one line per round ("Round 1 · commit <hash> · Failed at 14:10 · sent back to the agent"), the result that ended it, a round not taken never numbered ("Not confirmed · …" for a round the machine did not confirm, "Not sent back · …" for a failure read only after the wait or a round refused, from the refusal kept on the run; each "not counted"), and "Accepted later · Check CI again found CI passed at <time>", with "the failed attempt of this run no longer counts" after `ci_failed` (lot 3 step G2c), the latest refused submission (lot 3 step F4, "Latest refused submission": when and each check's result, as on the ticket page, with the files the agent listed folded; when the run's accepted submission is later, the card says first "The agent then handed its work in again, and it was accepted on <date>.", so it is not read as the run's outcome), so the owner sees why an agent was refused, also one refused again and again, and the log: one entry per transcript event (the agent's text, each tool with a short input, tool results cut to the "Longest stored log entry" setting), with credentials masked as in the event log. Logs are kept for as long as the run (owner's decision, lot 2 step A).
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

- Name, OS, account, status, last heartbeat, daemon version and build (with a warning when the build differs from the one the Orchestrator serves, lot 3), Claude Code version, capabilities, active runs.
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

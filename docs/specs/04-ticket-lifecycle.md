# 04 — Ticket Lifecycle and Definition of Done

> Status: Draft v0.1
> Related: [01 — Domain Model](01-domain-model.md), [05 — Daemon](05-daemon.md), [06 — MCP](06-mcp.md), [07 — Scheduler](07-scheduler.md)

This document defines the ticket states, who may move a ticket between them, and the checks that guard each transition. The rules are enforced by the web application: an MCP call or UI action that breaks them is rejected with an explanation.

## 1. States

| State | Meaning |
|---|---|
| `proposed` | Part of a plan not yet approved, or created by an agent with `ticket.create` and not yet accepted by the owner. Plan tickets are not visible on the board by default; tickets proposed by agents are (02, section 6.3). |
| `todo` | Approved and waiting for work. May be blocked or not assigned yet. |
| `in_progress` | A run is working on it. |
| `waiting_human` | An agent asked the owner a question. Work is paused until it is answered. |
| `in_review` | A pull request is open, CI is green, and the Quality agent is reviewing it. **In lot 2**, before pull requests and Quality exist, it means "work finished, the owner checks it": the agent submitted its report, no Quality run exists, and the ticket waits for the owner to mark it as done manually, cancel it, or leave it (owner's decision, lot 2 step A). |
| `awaiting_merge` | Review approved. The owner must merge the pull request on GitHub. |
| `done` | Pull request merged, or marked as done manually by the owner. Terminal. |
| `cancelled` | Abandoned. Terminal, except that the owner can reopen it. |

Blocked and eligible are derived conditions of `todo` (see 01, section 3.4). They are shown in the UI but are not states. The UI shows "Blocked" for `proposed` and `todo` tickets only, the states in which dependencies can still change; the API's `blocked` flag is computed for every ticket (owner's decision, lot 1 step F).

```mermaid
stateDiagram-v2
    [*] --> proposed: PM creates in a plan, or agent creates with ticket.create
    [*] --> todo: owner creates
    proposed --> todo: owner approves plan, or accepts an agent's ticket
    proposed --> cancelled: plan rejected or superseded, or owner rejects an agent's ticket
    todo --> in_progress: scheduler or Run now starts a run
    in_progress --> waiting_human: agent asks a question
    waiting_human --> in_progress: owner answers
    in_progress --> in_review: agent submits, DoD passes, CI green
    in_progress --> todo: run fails (retry), or owner stops the run
    waiting_human --> todo: owner stops the run, or its machine is lost
    in_review --> awaiting_merge: Quality approves
    in_review --> todo: Quality requests changes
    awaiting_merge --> done: PR merged on GitHub
    awaiting_merge --> todo: owner requests changes
    todo --> cancelled
    in_progress --> cancelled
    waiting_human --> cancelled
    in_review --> cancelled
    awaiting_merge --> cancelled
    todo --> done: owner marks as done manually
    in_progress --> done: owner marks as done manually
    waiting_human --> done: owner marks as done manually
    in_review --> done: owner marks as done manually
    awaiting_merge --> done: owner marks as done manually
    cancelled --> todo: owner reopens
    done --> [*]
    cancelled --> [*]
```

## 2. Transitions and who may perform them

| From → To | Performed by | Guard |
|---|---|---|
| (new) → `proposed` | Project Manager | Created inside a plan. |
| (new) → `proposed` | Any agent with `ticket.create` permission | Outside a plan. Limited per run (see section 8), flagged "created by agent", listed in "Needs you". The project is `ready` and not archived. |
| (new) → `todo` | Owner | — |
| `proposed` → `todo` | System, when the owner approves the plan | — |
| `proposed` → `todo` | Owner, with **Accept** | The ticket was created by an agent (no plan). |
| `proposed` → `cancelled` | System, when the plan is rejected or superseded | — |
| `proposed` → `cancelled` | Owner, with **Reject** | The ticket was created by an agent (no plan). An optional comment is posted as a `status_change` comment. |
| `todo` → `in_progress` | Scheduler, or the owner with **Run now** | Ticket is eligible (01, section 3.4) and its account can start a run (07, section 2, step 1, without the schedule windows); a run is created. Until the scheduler exists (lot 4), Run now is the only way a run starts (owner's decision, lot 2 step A). |
| `in_progress` → `waiting_human` | Assigned agent, by posting a `question` | Question body is not empty. |
| `waiting_human` → `in_progress` | System, when the owner posts an `answer` | The waiting run continues: its live session receives the answer, or, after the waiting run lifetime, the same run is resumed on the same machine at once (section 6). |
| `in_progress` or `waiting_human` → `todo` | Owner, with **Stop run** | The run is stopped and `cancelled`; the attempt is not counted; the branch is kept; a `status_change` comment records it. |
| `waiting_human` → `todo` | System | The waiting run's machine is offline when the answer arrives, or the owner stops a run whose machine is offline: the run fails with `machine_offline`, which is not counted as an attempt. |
| `in_progress` → `in_review` | Assigned agent, by calling `ticket.submit` | Submission checks pass (section 3.1; the reduced checks of lot 2 until lot 3). |
| `in_progress` → `todo` | System | Run failed; retry policy applies (section 5). A dispatch the machine did not acknowledge in time (07, section 8) returns the ticket to `todo` too, without counting an attempt. |
| `in_review` → `awaiting_merge` | Quality agent, by approving | Review checks pass (section 3.2). |
| `in_review` → `todo` | Quality agent, by requesting changes | At least one `review` comment explaining what to change. Next run has purpose `fix_review`. |
| `awaiting_merge` → `done` | System | GitHub reports the pull request merged into the default branch. |
| `awaiting_merge` → `todo` | Owner | Owner comment explaining the requested change. |
| any non-terminal → `cancelled` | Owner; Project Manager with owner approval | Active run is stopped; the branch and pull request are closed but kept. |
| `todo`, `in_progress`, `waiting_human`, `in_review` or `awaiting_merge` → `done` | Owner, with **Mark as done manually** | A comment explaining why is mandatory (posted as a `status_change` comment). Active run is stopped; the branch and pull request are left as they are. Tickets it blocked are unblocked. Allowed even while the ticket waits for tickets not `done`; the confirmation then warns and names them (02, section 6.4). |
| `cancelled` → `todo` | Owner, with **Reopen** | None. The ticket keeps its number, history and dependencies; `attempt_count` is reset to 0. |

Every transition writes an event (01, section 3.10) naming who performed it. Tickets are never deleted: a ticket created by mistake is cancelled.

A ticket's fields can be edited only in `proposed` and `todo` (02, section 6.4). The same applies to its dependencies: they can be added or removed only while the waiting ticket is `proposed` or `todo`, whatever the state of the blocking ticket (owner's decision, lot 1 step E).

Agents can never set `done` or `awaiting_merge` on their own work, and the Quality agent can never review a ticket it implemented. Only the owner can mark a ticket as done manually or reopen it.

## 3. Definition of Done

The DoD is checked at two points. The first check is mechanical and done by the system. The second is a judgement made by the Quality agent.

### 3.1 Submission checks (`in_progress` → `in_review`)

When the assigned agent calls `ticket.submit`, it sends a **DoD report**:

- for each acceptance criterion: `met` or `not_met`, with a one-line justification;
- tests added or changed (file paths), or a justification when none are needed;
- documentation updated (file paths), or a justification when not needed;
- ADRs added, if a technical decision was made;
- a short summary of the change for the pull request description.

The system then checks mechanically:

1. every acceptance criterion is reported as `met`;
2. the branch exists on GitHub and has commits ahead of the default branch;
3. a pull request is open from that branch (the daemon opens it if the agent has not);
4. CI on the pull request has completed and passed;
5. the rules for the ticket type are satisfied (section 3.3).

If CI is still running, the ticket stays `in_progress` and the run waits, up to a configurable timeout. If a check fails, the call is rejected with the list of failures and the agent continues working in the same run.

**Lot 2 (reduced submission).** Until pushing, pull requests and CI exist (lot 3), `ticket.submit` takes the same input, but only checks that every acceptance criterion is reported `met`, that the worktree has no uncommitted changes, and that the ticket branch has commits ahead of the base branch. When they pass, the report is stored, the run ends `succeeded` and the ticket moves to `in_review` with the lot 2 meaning (section 1); nothing is pushed. When they fail, the call is rejected with the failures, as above (owner's decision, lot 2 step A).

### 3.2 Review checks (`in_review` → `awaiting_merge`)

The Quality agent reviews the pull request and the DoD report. It verifies that:

- the change does what the acceptance criteria say, and nothing unrelated;
- the tests actually test the change, rather than existing only to satisfy the check;
- justifications for missing tests or documentation are acceptable;
- user documentation describes the change from the user's point of view;
- the code follows the project's CLAUDE.md conventions and existing ADRs.

It either approves, posting a `review` comment summarising the verdict, or requests changes with actionable comments.

### 3.3 Rules per ticket type

| Type | Tests | User documentation | ADR | Notes |
|---|---|---|---|---|
| `feature` | Required | Required if user-facing | If a technical decision was made | — |
| `bug` | A regression test that fails before the fix is required | Required if behaviour visible to users changed | Rarely | — |
| `chore` | Existing tests must pass | Not required | If a dependency or tool was added or replaced | Refactoring, tooling, dependencies. |
| `docs` | Not required | Is the deliverable | No | May be assigned to the Technical Writer. |
| `spike` | Not required | Not required | Required: the spike's findings are recorded as an ADR or a document in `docs/` | Research only; no production code. |

"Required" can be waived only by a justification in the DoD report, which the Quality agent must accept.

## 4. Git conventions

- One branch per ticket: `t/<number>-<slug>`, created from the default branch at the first run.
- One Git worktree per run, managed by the daemon.
- One pull request per ticket. Later runs (`fix_review`) push to the same branch.
- Pull request title: `<number>: <title>`. The description is built from the DoD report summary and links back to the ticket.
- If the default branch moved and the branch conflicts, the next run starts by rebasing. Unresolvable conflicts are raised as a `question`.
- Merge is done by the owner on GitHub. The web application detects merges by polling GitHub.
- Agent commits are authored as "<profile name> (Orchestrator)" with the owner's GitHub noreply address (`<id>+<login>@users.noreply.github.com`, from the id and login stored with the token, 02 section 3.2), so pushes pass GitHub's "block pushes that expose my email" option and GitHub links the commits to the owner's account. The daemon sets them per worktree.

## 5. Failures and retries

A run fails when it crashes, times out, the machine goes offline, or the agent declares it cannot finish.

- A run stopped because the Claude account reached its usage limit, or because the daemon suspects it did, is **not** a failure. The run goes to `paused_quota` and resumes later (see 07 and 05, section 4.10).
- A run stopped by the owner, a run failed with `machine_offline`, a run failed with `machine_revoked` (its machine was revoked while the run was active) and a dispatch not acknowledged in time are not failed attempts: the ticket returns to `todo` without changing `attempt_count` (owner's decisions, lot 2 steps A and C).
- Otherwise, the ticket returns to `todo`, `attempt_count` is incremented and the failure reason is posted as a `system` comment.
- After **2 failed attempts** (configurable), the ticket is not scheduled again. The system posts a `question` asking the owner how to proceed and moves the ticket to `waiting_human`.

## 6. Questions to the owner

- Agents ask questions with the `ticket.ask` MCP tool. The question is posted as a `question` comment and the ticket moves to `waiting_human`.
- The run stays alive for the waiting run lifetime (a setting, default 30 minutes, section 8) so an answer can resume it without losing context. After that, the tmux session is closed but the run stays `waiting_human`, with its worktree and Claude session id kept on its machine; the answer then resumes **the same run** on that machine at once (`run.resume`, 05 section 3.3), without waiting for the scheduler. If the machine is offline, the run fails with `machine_offline` and the ticket returns to `todo` (owner's decision, lot 2 step A).
- A waiting run does not count as active for the Claude account, so other tickets can run meanwhile.
- The UI shows pending questions prominently. They are the owner's main task list.

## 7. What the owner sees

- A board per project with one column per state (`proposed` hidden by default).
- On each ticket: description, acceptance criteria, assignee, dependencies, DoD report, comments, run history with logs, links to branch and pull request.
- A global "Needs you" view listing plans to approve, questions to answer and pull requests awaiting merge.

## 8. Configurable limits

Every limit and timeout of the Orchestrator is a setting, editable from the UI (Settings > Limits, 02 section 10) without touching the code. A setting is a value that changes what the Orchestrator does or accepts (refuse, wait, stop, retry). A value that only changes how much the screens show at once (for example the events per page of the event log, or the length of a quote in it) is not a setting but a named display constant in `packages/protocol` (owner's decision, lot 1 step H). Each setting is a whole number with a default and an allowed range; a value outside the range is refused. Some can also be overridden per project (project settings, 02 section 6.5). The value used is the project's override, then the global value, then the default. The user documentation lists every setting with its effect.

This table lists the settings of this document and the settings added in lots 0, 1 and 2. The daemon's timeouts (05, section 5) and the global scheduler settings (07, section 8) follow the same rules and are shown on the same screen. Settings of a Claude account (schedule windows, daily budget, behaviour at window end, maximum concurrent runs) are set on the account (02, section 9.1), not here.

| Setting | Default | Allowed range | Override per project | Used in |
|---|---|---|---|---|
| Max tickets per plan | 15 | 1 to 100 | Yes | 01, section 3.3 |
| Max tickets an agent may create per run (outside a plan) | 3 | 0 to 20 | Yes | Section 2 |
| Max failed attempts before asking the owner | 2 | 1 to 10 | Yes | Section 5 |
| CI wait timeout at submission | 20 minutes | 1 to 240 minutes | Yes | Section 3.1 |
| Waiting run lifetime: how long a waiting run stays alive after a question | 30 minutes | 1 to 1,440 minutes | No | Section 6; 05, section 5 |
| Session lifetime | 30 days | 1 to 365 days | No | 09, section 5 (ADR 0015) |
| Failed logins before a delay | 5 | 1 to 100 | No | 09, section 5 (ADR 0015) |
| First login delay (doubles with each further failure) | 10 seconds | 1 to 3,600 seconds | No | 09, section 5 (ADR 0015) |
| Longest login delay | 900 seconds (15 minutes) | 1 to 86,400 seconds (24 hours) | No | 09, section 5 (ADR 0015) |
| Failed login memory | 60 minutes | 1 to 10,080 minutes (7 days) | No | 09, section 5 (ADR 0015) |
| GitHub token expiry warning | 14 days | 1 to 90 days | No | 02, section 4 |
| GitHub request timeout | 15 seconds | 1 to 300 seconds | No | 09, section 4 |
| GitHub clock tolerance | 120 seconds (2 minutes) | 0 to 3,600 seconds | No | 08, section 3.1 |
| Longest ticket title | 200 characters | 1 to 1,000 characters | No | 01, section 3.4 |
| Longest ticket description | 20,000 characters | 1 to 100,000 characters | No | 01, section 3.4 |
| Max acceptance criteria per ticket | 20 | 1 to 100 | No | 01, section 3.4 |
| Longest acceptance criterion | 500 characters | 1 to 5,000 characters | No | 01, section 3.4 |
| Longest comment | 20,000 characters | 1 to 100,000 characters | No | 01, section 3.5 |
| Enrollment code lifetime | 15 minutes | 1 to 1,440 minutes | No | 05, section 3.1 |
| Heartbeat interval (sent to the daemon when it connects) | 15 seconds | 5 to 120 seconds | No | 05, section 3.2 |
| Machine offline after (no heartbeat for this long) | 60 seconds | 15 to 600 seconds | No | 05, section 3.2 |
| Session start timeout (no `SessionStart` hook after the launch) | 30 seconds | 5 to 600 seconds | No | 05, section 4.2.1 |
| Progress update interval (shortest time between two publications of a run's progress line; the agent's calls are never refused, the latest line is kept) | 60 seconds | 0 to 3,600 seconds | No | 06, section 4.2 |
| MCP call timeout (how long the daemon waits for the server's answer to a tool call) | 30 seconds | 5 to 300 seconds | No | 05, section 3.3 |
| Claude Code MCP tool timeout (written by the daemon into each run's `mcp.json`) | 120 seconds | 10 to 1,800 seconds | No | 05, section 4.2 |
| Longest stored log entry | 2,000 characters | 100 to 100,000 characters | No | 02, section 7 |

The maximum concurrent runs of a Claude account (1 by default) is set on the account (01, section 3.9). The project setup polling interval added in lot 1 (`projectSetupPollSeconds`) is removed in lot 2, when the realtime stream replaces the polling (02, section 1); a stored value is dropped with it.

The first login delay is never above the longest login delay: a change or a **Reset to default** that would make it so is refused, naming both settings (the same rule as the quota fallback delays, 07 section 8). Two more pairs follow the same rule with a clear message naming both settings (owner's decision, lot 2 step A): "Machine offline after" is at least twice the heartbeat interval, so one lost heartbeat never marks a machine offline; and the MCP call timeout is below the Claude Code MCP tool timeout, so the daemon always answers Claude Code (with `UNAVAILABLE`) before Claude Code gives up on the call. The ranges keep the owner from locking themselves out: a login wait is at most 24 hours, and `orchestrator reset-password` (09, section 7.4) also lifts an active wait. Settings added in lots 0 and 1 are global only (owner's decision, lot 1 step G), and so are those added in lot 2. Lot 2 (version 0.3.0) starts using: max tickets an agent may create per run, the waiting run lifetime, the daemon timeouts of 05 section 5 (maximum run duration, idle timeout, maximum nudges), the dispatch acknowledgement timeout and the quota fallback delay (07, section 8), and every setting added by lot 2 above. Every value is read through the one settings resolver (project override, then global value, then default). A setting used only from a later version is shown with "Used from version ..." and can be set before it has any effect.

Changing a limit applies to future actions only; runs and plans already in progress keep the values they started with, and an open login session keeps its expiry date. Every change of a global value or a project override, and every **Reset to default**, writes an event.

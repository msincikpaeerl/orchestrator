# 07 — Scheduler and Quota

> Status: Draft v0.1
> Related: [01 — Domain Model](01-domain-model.md), [04 — Ticket Lifecycle](04-ticket-lifecycle.md), [05 — Daemon](05-daemon.md)

The scheduler decides **which run starts, when, and on which machine**. It is deterministic server code: agents never start runs themselves (00, principle 3). Its main constraint is the Claude Pro quota, which is shared with the owner's personal use and cannot be read directly.

## 1. What the scheduler can start

| Run purpose | Created when |
|---|---|
| `plan` | A request is submitted, or a plan is rejected with feedback. |
| `implement` | A ticket is eligible (01, section 3.4). |
| `fix_review` | A ticket returns to `todo` after changes were requested. |
| `review` | A ticket enters `in_review`. |
| resume | A run in `paused_quota` can continue, or an owner answer arrives for a run whose session was closed. |

## 2. Scheduling loop

The loop runs when something relevant happens (ticket status change, run end, machine online, account available, schedule window opens, setting change) and at least once per scheduler tick (section 8).

For each Claude account:

1. **Is the account available?** State `available`, current time inside a schedule window (if any), daily working-time budget not exhausted, fewer active runs than `max_concurrent_runs`. If not, skip the account.
2. **Pick the next candidate** in priority order (section 3).
3. **Pick a machine** (section 4). If none fits, try the next candidate.
4. **Create the run** in `queued`, then send `run.start` to the machine; the run becomes `dispatched`.
5. If the daemon does not acknowledge within the dispatch acknowledgement timeout (section 8), the run is cancelled without counting as a failed attempt, and the candidate goes back to the queue.

Only one scheduler instance runs at a time, guarded by a PostgreSQL advisory lock, so the loop can never start the same work twice.

## 3. Priority order

Candidates are ordered by category, then within a category.

| Order | Category | Why |
|---|---|---|
| 1 | Resumes (quota pause, answered questions) | Their context already exists; finishing them is the cheapest progress. |
| 2 | `review` | Unblocks finished work quickly and is usually short. |
| 3 | `fix_review` | Finishes work already started. |
| 4 | `plan` | The owner is waiting for a proposal. |
| 5 | `implement` | New work. |

Within a category: ticket priority (`high` first), then tickets that block the most other tickets, then oldest first. When several projects have candidates at the same level, projects are served in turn so one large project does not starve the others.

The owner can use **Run now** on a ticket to move it to the front. Run now ignores schedule windows but never ignores the quota state or the concurrency limit.

## 4. Machine selection

A machine can take a run when it is:

- `online` and not `disabled`;
- logged into the run's Claude account;
- holding every capability required by the project and the agent profile;
- running a daemon version compatible with the server (09, section 6).

Among suitable machines, prefer the one that already has the repository cloned, then the one that ran the ticket last (warm worktree for resumes; required for `quota_paused` runs, which resume on their own machine), then the one with the fewest runs today.

## 5. Quota management

### 5.1 What can and cannot be known

A Pro subscription does not expose its remaining usage. The Orchestrator cannot know in advance how much a run will cost or how much quota is left, especially since the owner uses the same account for personal work. The scheduler therefore relies on:

- **prevention**: schedule windows and a daily working-time budget, so agents work when the owner does not;
- **detection**: the daemon reports when the limit is reached (05, section 4.10);
- **recovery**: paused runs resume where they stopped.

### 5.2 When the limit is reached

1. The daemon sends `run.quota_limited`. The run moves to `paused_quota`. This is not a failure (04, section 5).
2. The account moves to `limited`, with `limited_until` set to the reset time reported by Claude Code, or to **now + 1 hour** when no time is available.
3. No run starts on this account while it is `limited`. Other accounts, if any, are unaffected.
4. At `limited_until`, the account returns to `available` and the paused run is resumed first. It acts as the probe: if the limit is still reached, the account goes back to `limited` with the next estimate, doubling the fallback delay up to 4 hours.
5. The UI shows the limit, the expected reset time, and a history of limits reached, so the owner can adjust windows and budget.

### 5.3 Schedule windows

- An account can have zero or more weekly windows (for example Monday–Friday 00:00–08:00 and weekends all day). No window means always allowed.
- New runs start only inside a window.
- When a window ends while a run is active, the run **finishes** by default. A setting allows pausing it at the end of the window instead; it is then resumed like a quota pause.

### 5.4 Daily working-time budget

An optional daily limit per account (default: none), expressed either as working time or as **estimated usage**. Estimated usage is the equivalent cost that Claude Code records in each session transcript (`cost-state`, see ADR 0002). It does not convert exactly into Pro quota, but it measures what runs really consume, including the fixed cost of each turn, far better than time. Working time counts only periods where the agent is actually working (05, section 5), not waiting. When the budget is exhausted, no new run starts until the next day; the active run finishes.

Estimated usage is also shown per run, per ticket and per day, so the owner can learn what a typical ticket costs and set the budget accordingly.

This is the owner's main lever to keep quota for personal use.

### 5.5 Manual pause

The owner can pause an account at any time from the UI or the "Needs you" view. Options: **stop new runs** (active ones finish) or **pause now** (active runs are paused like a quota pause). Resume is manual.

## 6. Other rules

- **Retries** follow 04, section 5. A failed candidate returns to the queue behind other candidates of the same category.
- **Cancelled tickets** stop their active run immediately (`run.stop`).
- **Machine offline** with an active run: handled by the daemon reconciliation rules (05, section 6).
- **Fairness between runs of one ticket**: never more than one active run per ticket (01, invariant 2).

## 7. What the owner sees

- Per account: state, next window, time until reset when limited, working time and estimated usage today against the budget, runs today.
- The queue: next candidates in order, with the reason when something cannot start ("waiting for window at 00:00", "no machine with android-sdk", "blocked by WEB-3").
- Per run: time working, time waiting (owner, CI, quota).

## 8. Settings

| Setting | Default | Scope |
|---|---|---|
| Schedule windows | None (always) | Account |
| Daily budget (working time or estimated usage) | None | Account |
| Behaviour at window end | Finish current run | Account |
| Fallback delay when reset time is unknown (doubles each time the limit is still reached) | 1 hour | Global |
| Longest fallback delay | 4 hours | Global |
| Dispatch acknowledgement timeout (also for runs started with **Run now**) | 60 seconds | Global |
| Scheduler tick | 30 seconds | Global |

All follow the settings rules of 04, section 8. The global ones are shown on Settings > Limits (02, section 10); the others are set on the account (02, section 9.1).

# 07 — Scheduler and Quota

> Status: Draft v0.1
> Related: [01 — Domain Model](01-domain-model.md), [04 — Ticket Lifecycle](04-ticket-lifecycle.md), [05 — Daemon](05-daemon.md)

The scheduler decides **which run starts, when, and on which machine**. It is deterministic server code: agents never start runs themselves (00, principle 3). Its main constraint is the Claude Pro quota, which is shared with the owner's personal use and cannot be read directly.

## 1. What the scheduler can start

| Run purpose | Created when |
|---|---|
| `plan` | A request is submitted, or a plan is rejected with feedback. |
| `implement` | A ticket is eligible (01, section 3.4). |
| `fix_review` | A ticket returns to `todo` after changes were requested (Quality's, or the owner's **Request changes**). |
| `review` | A ticket enters `in_review` with a pull request, while its project's **Start reviews by themselves** is on (below). |
| resume | A run in `paused_quota` can continue, or an owner answer arrives for a run whose session was closed. |

**Lot 4** (owner's answers 1, 3 and 4, lot 4 step A):

- **Reviews and fixes start by themselves.** A `review` candidate exists only while the project's switch **Start reviews by themselves** (02, section 6.5; on by default) is on; when it is off, a review starts only with the owner's **Start review**, as in lot 3. **Skip review** stays possible until the review run starts; **Start review** moves the review to the front. A `fix_review` candidate follows Quality's request for changes and the owner's **Request changes** alike; the confirmation's **Run now** stays, to move it to the front. `plan` runs come with lot 5: before then the scheduler has no `plan` candidate.
- **What is never a candidate**: a ticket stopped by the retry policy (04, section 5.2); a ticket with a blocking "Needs you" item (04, section 5.1), while the item stands; a ticket **held** after the owner's **Stop run**, or after a **Request changes** with its hold box checked (04, section 2; owner's new answer 2, lot 4 step A), until the owner's **Run now**, which releases it and starts it, with its usual refusals. The board, the ticket page and the queue show a held ticket as "Held: you stopped its run" with how to release it.

## 2. Scheduling loop

The loop runs when something relevant happens (ticket status change, run end, machine online, account available, schedule window opens, setting change) and at least once per scheduler tick (section 8).

For each Claude account:

1. **Is the account available?** State `available` (not `limited`, not `paused_manual`), current time inside a schedule window (if any; section 5.3), daily budget not used up (section 5.4), fewer active runs than `max_concurrent_runs` (a run waiting for CI counts, section 3). If not, skip the account.
2. **Pick the next candidate** in priority order (section 3).
3. **Pick a machine** (section 4). If none fits, try the next candidate.
4. **Create the run** in `queued`, then send `run.start` to the machine; the run becomes `dispatched`.
5. If the daemon does not acknowledge within the dispatch acknowledgement timeout (section 8), the run is cancelled without counting as a failed attempt, and the candidate goes back to the queue, never to the same machine at once (section 4, "Failures the machine caused").

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

Within a category: ticket priority (`high` first), then tickets that block the most other tickets (counting the tickets waiting on it directly or through others; owner's answer 15a, lot 4 step A), then oldest first. When several projects have candidates at the same level, projects are served in turn so one large project does not starve the others.

The owner can use **Run now** on a ticket to move it to the front. Run now ignores schedule windows and the daily budget but never ignores the quota state, a manual pause or the concurrency limit: it refuses an account `limited` or `paused_manual` and one already running its maximum (owner's answer 5, lot 4 step A). The loop and Run now share the account check, the candidate's checks and the machine choice, so both refuse for the same reasons in the same words, which the queue shows (section 7). Run now releases a held ticket (section 1).

**Lot 2, before the loop exists.** Run now is the only way a run starts. It checks the ticket is eligible and its account can start a run (section 2, step 1, without schedule windows and budget), picks a machine (section 4), creates and dispatches the run (section 2, steps 4 and 5). When it cannot start, the owner sees why: no assignee, blocked, no compatible machine online, account limited (until when), account already running its maximum, or the ticket too large for a run's first message even with its description cut (03 section 3.2; the message says to shorten the ticket, for example its dependencies or acceptance criteria; owner's decision, review of lot 2 step I). An owner's answer to a question whose session was closed resumes the same run through the same path (04, section 6), and so does **Resume** on a paused run (owner's decision, lot 2 step A).

Run now in lot 2, precisely (owner's decisions, lot 2 step J):

- **Refusals**, each with a named reason in the answer and plain words on screen: the ticket is not `todo`, has no assignee, or is blocked (naming the tickets it waits for); the project is archived or not ready; the GitHub token is missing, unreadable or invalid; the GitHub account id, needed for the commit author (04, section 4), cannot be read at the first run; the ticket is too large for its first message; the ticket's branch holds commits on a machine that cannot take the run (below); no machine can take the run. The last one lists every machine with why it cannot: offline, disabled, unusable (with its reason), a missing capability, its account limited (until when) or already running its maximum (stating the account's maximum concurrent runs). A refusal tied to a setting or an account value states its current value.
- **The machine holding the ticket's work.** Until branches are pushed (lot 3), a ticket's commits exist only in the bare clone of the machine that made them. When the ticket's latest run that reported commits ahead of the base branch ran on a machine not revoked, Run now uses only that machine; if it cannot take the run, Run now refuses, naming the machine and why. When that machine was revoked, the run starts from the base branch on another machine, and the server posts a `system` comment on the ticket saying that the earlier work on machine <name> is no longer available, with the number of commits lost.
- **Attempt number.** The first message states the run's attempt at the ticket: the ticket's earlier runs that a machine acknowledged, plus one, review runs left out (a review run states the attempt it reviews; owner's review of lot 3 step H1). Runs stopped by the owner or failed with `machine_offline` count here; `attempt_count` (01, section 3.4) still counts only failed attempts, for the retry policy. When the chosen machine's latest run of the ticket reported commits ahead of the base branch, the first message says so and tells the agent to read them and continue that work (03, section 3.2).
- **Resume** of a paused run is sent only to the run's own machine. When that machine is offline, disabled or unusable, Resume is refused with the named reason and the run stays `paused_quota`; **Stop run** still works. The run is `dispatched` while `run.resume` waits for its acknowledgement; without one within the dispatch acknowledgement timeout, the run returns to `paused_quota` with an event, no attempt is counted, and Resume can be tried again.
- An account whose `limited_until` has passed is treated as `available` by Run now, Resume and the screens at once; the first action that reads it writes the change and its event (`account.available`).

**Lot 3, before the loop exists** (owner's decisions, lot 3 step A):

- **Run now** on a `todo` ticket starts a `fix_review` run when the ticket's latest request for changes (Quality's, or the owner's **Request changes**) came after its latest accepted submission, and an `implement` run otherwise. It refuses a ticket stopped by the retry policy (04, section 5), naming the setting and its value. A `fix_review` run chooses its machine as an `implement` run does (below), a ticket left by 0.3.0 included; when the machine holding the work was revoked, it is still `fix_review`, its first message saying that the branch starts again and to implement the ticket with the points in mind (owner's answer 5, lot 3 step I).
- **Start review** on an `in_review` ticket with a pull request and no active review run starts a `review` run with the `quality` profile, through the same checks and machine selection; the ticket's assignee is not used. **Skip review** starts nothing.
- **The machine holding the ticket's work** applies only to commits not on GitHub: the commits of the latest run (never a review run, which reports GitHub's head and never holds work) that its machine said were on no branch fetched from GitHub and that no push held, plus those beyond the report's ceiling, which count as not on GitHub (01, sections 3.4 and 3.7; lot 3 step D3). When there are none, any suitable machine can take the run (section 4's preferences apply), and a machine without the ticket's branch takes it from GitHub; the first message then says the branch already has commits. When there are some, only that machine can take the run, also when its last push was refused as `diverged`; the refusal gives their number ("The ticket's branch has 2 commits not on GitHub, only on machine Laptop, and it is offline."). When that machine was revoked, the comment counts only the commits not on GitHub as lost, and the run starts from the branch as last pushed to GitHub (from the base branch when nothing was pushed). Tickets left by 0.3.0 have no push, so they keep the lot 2 rule. Getting out of a `diverged` state (the run told to merge GitHub's branch, the `push_failed` "Needs you" item) is step F's.
- A run waiting for CI counts against its account's maximum concurrent runs (04, section 3.1). It still does once runs start by themselves (owner's answer 2, lot 4 step A): the wait is short, and the rule stays the same for Run now and the loop.

## 4. Machine selection

A machine can take a run when it is:

- `online` and not `disabled`;
- logged into the run's Claude account;
- holding every capability required by the project and the agent profile;
- running a daemon version compatible with the server (09, section 6).

**Failures the machine caused** (owner's answer 3 and its condition, lot 4 step A). A run that fails without counting and without a "Needs you" item of its ticket, because of its machine, leaves that machine out of the choice until something changes:

- `machine_offline`: the machine is offline until it connects again;
- `machine_revoked`: the machine never takes a run again;
- `claude_code_unsupported`: the machine is marked unusable in the same transaction as the failure, until a `hello` or a run's start reports a supported version (05, section 4.3);
- `machine_problem`: the daemon reports its process scope error at once (`machine.doctor`, 05 section 3.3), which makes the machine unusable until the daemon is restarted; the run's end and that report are two messages, and a start sent between them is refused by the daemon, which refuses every start while the error stands;
- a dispatch not acknowledged within the dispatch acknowledgement timeout, or refused by the daemon: the machine can stay online and usable (a daemon stopping, a slow one).

So that none of them starts the same ticket on the same machine in a loop (owner's answer 3 and new answer 1, lot 4 step A; tested in step D2): after one of these failures, the scheduler does not start that ticket on that machine again until the machine connects again (`hello`) or the owner uses **Run now** on the ticket; once they reach **Machine failures before asking you** (section 8; 2 by default, read at that failure) for the same ticket on the same machine in a row, with no other ending of a run of that ticket between them (a reconnection between them does not count as one), the ticket gets a blocking "Needs you" item, "<ticket> could not start on <machine>", giving the reasons (with the value 1, the first failure leaves it), with **Run now**, and the scheduler does not start it while the item stands. A ticket tied to that machine by commits not on GitHub (section 3) waits meanwhile, its queue line saying why.

Among suitable machines, prefer the one that already has the repository cloned, then the one that ran the ticket last (warm worktree for resumes; required for `quota_paused` runs, which resume on their own machine, and, until branches are pushed in lot 3, for a ticket whose branch holds commits on that machine: section 3), then the one with the fewest runs today.

## 5. Quota management

### 5.1 What can and cannot be known

A Pro subscription does not expose its remaining usage. The Orchestrator cannot know in advance how much a run will cost or how much quota is left, especially since the owner uses the same account for personal work. The scheduler therefore relies on:

- **prevention**: schedule windows and a daily working-time budget, so agents work when the owner does not;
- **detection**: the daemon reports when the limit is reached (05, section 4.10);
- **recovery**: paused runs resume where they stopped.

### 5.2 When the limit is reached

1. The daemon sends `run.quota_limited`. The run moves to `paused_quota`. This is not a failure (04, section 5).
2. For a **detected** limit, the account moves to `limited`, with `limited_until` set to the reset time reported by Claude Code, or to **now + the fallback delay** (1 hour by default) when no time is available. A detected limit is a known usage-limit message, or a `rate_limit` failure while a window shows 100 % (05, section 4.10). A **suspected** limit (a `rate_limit` failure alone, `overloaded`, `server_error`, or an API error turn with no tool use; 05, section 4.10) leaves the account unchanged: only the run is paused, with reason "suspected usage limit", and **Resume** is allowed at once (owner's decision, lot 2 step A). From lot 4 the scheduler also resumes it by itself (owner's answer 9, lot 4 step A): after **Quota wait when the reset time is unknown**, doubled for the same run each time it pauses again on a limit, up to **Longest quota wait**; the account stays unchanged, so other runs keep starting on it, and the doubling restarts once the resumed run ends a turn without a limit. In both cases no nudge is sent and no failed attempt is counted, and Claude Code's own automatic continuation after a limit (`autoContinueAtUsageLimit`) is off for every run.
3. No run starts on this account while it is `limited`. Other accounts, if any, are unaffected.
4. At `limited_until`, the account returns to `available` and the paused run is resumed first. In lot 2, before the loop exists, the owner resumes it with **Resume** ("Needs you" lists it), which is refused before `limited_until`. From lot 4 the scheduler resumes it, first in its account's queue and only on the run's own machine (an offline or unusable machine keeps it paused, with the reason in the queue); **Resume** by the owner stays. It acts as the probe: if the limit is still reached, the account goes back to `limited` with the next estimate, doubling the fallback delay up to **Longest quota wait** (4 hours by default); the doubling restarts once a run of the account ends a turn without a limit. The resume's message is the "please continue" template (03, section 3.2).
5. The UI shows the limit, the expected reset time, and a history of limits reached, so the owner can adjust windows and budget.

### 5.3 Schedule windows

- An account can have zero or more weekly windows (for example Monday–Friday 00:00–08:00 and weekends all day). No window means always allowed.
- New runs start only inside a window. A window may cross midnight.
- Windows, and the day of the daily budget and of "runs today", are read in **the Orchestrator's time zone**, one for the whole Orchestrator, set on Settings (02, section 10) and filled in from the owner's browser, daylight saving changes included (owner's answer 6, lot 4 step A).
- When a window ends while a run is active, the run **finishes**. In lot 4 this is the only behaviour (owner's answer 7, lot 4 step A). Pausing the run at the end of the window instead, then resuming it like a quota pause, is kept for later with **Pause now** (section 5.5): both need a daemon command that pauses a run (`run.pause`), so a raise of the protocol version, and no lot plans them yet.

### 5.4 Daily working-time budget

An optional daily limit per account (default: none), expressed either as working time or as **estimated usage**. Estimated usage is the equivalent cost that Claude Code records in each session transcript (`cost-state`, see ADR 0002). It does not convert exactly into Pro quota, but it measures what runs really consume, including the fixed cost of each turn, far better than time. Working time counts only periods where the agent is actually working (05, section 5), not waiting. When the budget is exhausted, no new run starts until the next day (in the Orchestrator's time zone, section 5.3); the active run finishes. **Run now** ignores the budget (section 3).

Estimated usage is also shown per run, per ticket and per day, so the owner can learn what a typical ticket costs and set the budget accordingly.

This is the owner's main lever to keep quota for personal use.

### 5.5 Manual pause

The owner can pause an account at any time from the UI or the "Needs you" view. Options: **stop new runs** (active ones finish) or **pause now** (active runs are paused like a quota pause). Resume is manual.

Lot 4 builds **Stop new runs** (the account `paused_manual`; active runs finish; **Run now** refused) and **Resume** (owner's answer 7, lot 4 step A). **Pause now** is kept for later with the window end's pause (section 5.3). To free the quota at once, the owner stops a run with **Stop run**: its ticket is then held from the scheduler (section 1).

## 6. Other rules

- **Retries** follow 04, section 5. A failed candidate returns to the queue behind other candidates of the same category. A failure that is not counted and leaves a blocking "Needs you" item (04, section 5.1) keeps the ticket out of the queue while the item stands; one the machine caused follows section 4.
- **Cancelled tickets** stop their active run immediately (`run.stop`).
- **Machine offline** with an active run: handled by the daemon reconciliation rules (05, section 6), after **Runs of an offline machine fail after** (section 8).
- **Fairness between runs of one ticket**: never more than one active run per ticket (01, invariant 2).

## 7. What the owner sees

- Per account: state, next window, time until reset when limited, working time and estimated usage today against the budget, runs today, the history of limits reached.
- The queue: next candidates in order, with the reason when something cannot start ("waiting for window at 00:00", "no machine with android-sdk", "blocked by WEB-3", "Held: you stopped its run").
- Per run: time working, time waiting (owner, CI, quota).

## 8. Settings

| Setting | Default | Allowed range | Scope |
|---|---|---|---|
| Schedule windows | None (always) | Set on the account | Account |
| Daily budget (working time or estimated usage) | None | Set on the account | Account |
| Behaviour at window end | Finish current run (the only behaviour in lot 4, section 5.3; not shown until a second one exists) | Set on the account | Account |
| Quota wait when the reset time is unknown (`quotaFallbackDelayMinutes`; doubles each time the limit is still reached) | 1 hour | 1 to 1,440 minutes | Global |
| Longest quota wait (`quotaFallbackMaxDelayMinutes`) | 4 hours | 1 to 2,880 minutes | Global |
| Machine answer timeout (`dispatchAckTimeoutSeconds`; the dispatch acknowledgement timeout, also for runs started with **Run now**) | 60 seconds | 5 to 600 seconds | Global |
| Scheduler check interval (`schedulerTickSeconds`) | 30 seconds | 5 to 600 seconds | Global |
| Runs of an offline machine fail after (`offlineRunFailMinutes`; lot 4, owner's answer 10; 05, section 6) | 10 minutes | 1 to 1,440 minutes | Global |
| Machine failures before asking you (`maxMachineFailures`; lot 4, owner's new answer 1 of step A; section 4) | 2 | 1 to 10 | Global |

The longest fallback delay is never below the fallback delay: a change or a **Reset to default** that would make it so is refused, naming both settings.

All follow the settings rules of 04, section 8. The dispatch acknowledgement timeout and the fallback delay are used from version 0.3.0 (lot 2); the longest fallback delay, the scheduler tick, **Runs of an offline machine fail after** and **Machine failures before asking you** from version 0.5.0 (lot 4). The Orchestrator's time zone (section 5.3) is not a limit: it is on Settings, outside Settings > Limits (02, section 10). The global ones are shown on Settings > Limits (02, section 10); the others are set on the account (02, section 9.1).

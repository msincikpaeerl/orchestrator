# Lot 4 — Implementation plan

> Status: step A in progress (2026-10-18): plan written, waiting for the owner's answers to step A's questions
> Scope: "Lot 4 — Scheduler and quota" in [10 — Delivery Plan](../specs/10-delivery-plan.md), and the items of lot 3's "Carried to lot 4" ([lot 3 plan](lot-3-plan.md#carried-to-lot-4)).
> **Lot 4 is done when** the owner leaves the system running overnight and finds the eligible tickets processed, with quota limits handled without repeated failures.

Every session follows the [working rules](working-rules.md). Branches: `lot4/<step letter>-<short-name>`. Steps are done one after the other, in the order below, each in its own session once the previous one is merged (rule 18). No session acts on the real GitHub (rule 9) or starts a real Claude Code session (rule 10): the scheduler is tested with the server's own clock moved by the tests, the fake GitHub and the fake `claude`. The real GitHub and the real Claude Code are used only by the owner, in step L. Lot 4 is released as version 0.5.0.

## Decisions taken for this lot (2026-10-18)

### Already decided

From the specs and earlier lots; nothing here waits for an answer.

- **What starts runs** (07, sections 1 to 4): one scheduler instance, guarded by a PostgreSQL advisory lock, runs its loop when something relevant happens (ticket status change, run end, machine online, account available, window opening, setting change) and at least once per **Scheduler check interval** (`schedulerTickSeconds`, 30 seconds, used from 0.5.0). Per account: available, inside a window, budget not used up, fewer active runs than its maximum; then the next candidate in priority order (resumes, `review`, `fix_review`, `plan`, `implement`; then ticket priority, the tickets it blocks, oldest first; projects served in turn); then a machine (online, not disabled, usable, logged into the account, every capability; preferring the repository already cloned, then the ticket's last machine, then the fewest runs today). `plan` runs come with lot 5: the scheduler has no `plan` candidate before then.
- **Run now** stays (07, section 3): it moves a ticket to the front, ignores schedule windows, never ignores the quota state or the concurrency limit, and keeps every refusal of lots 2 and 3. It goes through the same account and machine checks as the loop, so both refuse for the same reasons in the same words.
- **The machine holding the ticket's work** (07, section 3, lot 3 step D3) applies to the scheduler as to **Run now**: commits not on GitHub tie the ticket to their machine.
- **Quota** (07, section 5.2): a run paused on a detected limit is resumed first, by the scheduler, once `limited_until` has passed; the resume acts as the probe, and a limit still reached sends the account back to `limited` with the fallback delay doubled, up to **Longest quota wait** (`quotaFallbackMaxDelayMinutes`, 4 hours, used from 0.5.0). Nothing changes in detection (05, section 4.10).
- **Schedule windows, daily budget, behaviour at window end, manual pause** (07, sections 5.3 to 5.5; 01, section 3.9; 02, section 9.1): set on the Claude account. The budget is working time or estimated usage; once used up, no new run starts that day and the active one finishes. Estimated usage is shown per run, per ticket and per day. The account's state `paused_manual` already exists in the database's check constraint (lot 2).
- **What the owner sees** (07, section 7; 02, sections 4, 7 and 9.1): per account its state, next window, time until reset, working time and estimated usage today against the budget, runs today, and the history of limits reached; Activity > **Queue** with the next candidates and why each is not running ("waiting for window at 00:00", "no machine with android-sdk", "blocked by WEB-3"); per run the time working and the time waiting, split between the owner, CI and the quota. The account status line on "Needs you" gains "Paused" and the next window.
- **Reconciliation** (05, section 6): the daemon is the source of truth for processes, the server for tickets; at `hello` a run unknown to the server is stopped (lot 2) and a run the server thinks active that the daemon does not report fails with `machine_offline`; a run whose machine stays offline too long fails and follows the retry policy (the delay: question 10).
- **The blocking rule** (10, lot 4; 04, section 5.1): a failure that is not counted (`ci_timeout`, `push_failed`, `download_failed`, a review run that did not finish) leaves a blocking "Needs you" item, and the scheduler never starts that ticket again while the item stands. A counted failure returns the ticket to the queue behind the other candidates of its category (07, section 6), until **Failed attempts before asking you** stops it (lot 3 step K1).
- **Settings marks**: **Scheduler check interval** and **Longest quota wait** lose their "Used from version 0.5.0" in step L (rule 14); **Most tickets per plan** (0.6.0) keeps its mark and stays the one `settings.e2e.ts` checks.

### Proposed, waiting for the owner's answers

Each line gives the recommended option of step A's question (Q). Step A's second commit replaces this section with the answers and writes them into the specs named.

- **Q1, reviews and fixes by themselves** (07 section 1, 04 section 2, 03): the scheduler starts a `review` run when a ticket enters `in_review` and a `fix_review` run after a request for changes (Quality's or the owner's), with a per-project switch **Start reviews by themselves** (on by default) on the project settings page. **Skip review** stays possible until the review run starts. **Start review** stays as the owner's way to move a review to the front.
- **Q2, waiting for CI** (07 section 3, 01 invariant 3): a run waiting for CI keeps counting against its account's maximum concurrent runs.
- **Q3, uncounted failures** (04 section 5.1): `ci_cancelled` gets a blocking item too; `machine_offline`, `machine_revoked`, `claude_code_unsupported`, `machine_problem` and a dispatch not acknowledged leave no item: the machine at fault is offline or unusable, so the scheduler starts the ticket again only on a machine that can take it.
- **Q4, Stop run**: a ticket whose run the owner stopped is held from the scheduler until the owner's **Run now**, shown on the board, the ticket page and the queue ("Held: you stopped its run").
- **Q5, Run now and the account** (07 section 3): Run now ignores schedule windows and the daily budget, refuses a paused or limited account and an account at its maximum.
- **Q6, time zone**: one time zone for the Orchestrator, chosen on Settings and filled in from the browser, used by the windows, the budget's day and "runs today".
- **Q7, pausing a run** (07 sections 5.3 and 5.5): **Pause now** and the window end's "pause" option are built; they need a new daemon command, `run.pause`, so `PROTOCOL_VERSION` becomes 3 (rule 13).
- **Q8, Push again**: not in lot 4 (moved to lot 7 with lot 3's design): rare once the token check was fixed, and **Run now** covers it.
- **Q9, suspected limits** (07 section 5.2): the scheduler resumes a run paused on a suspected limit after **Quota wait when the reset time is unknown**, doubled for the same run each time it pauses again, up to **Longest quota wait**; the account is unchanged. The doubling restarts once a resumed run ends a turn without a limit.
- **Q10, an offline machine's runs** (05 section 6): a new global setting **Runs of an offline machine fail after** (`offlineRunFailMinutes`, 10 minutes, 1 to 1,440), replacing the spec's fixed 10 minutes, for runs `dispatched`, `starting` and `running` (waiting for CI included); runs waiting for the owner or paused keep waiting, since the answer and **Resume** already fail them when the machine is offline.
- **Q11, agents under their own system user**: stays in lot 7.
- **Q12, usage-limit capture**: if the limit is reached during lot 4, the owner runs `--scan-limit` and `--probe-limit`; otherwise the capture moves to lot 7.
- **Q13, criteria numbers**: numbered from 1 wherever an agent reads or names them.
- **Q14, a request contradicting a criterion**: the **Request changes** dialog says to edit the criteria too (the ticket is **To do** afterwards, so **Edit** is offered), Help says so, and the `fix_review` message says the owner's request comes after the criteria.
- **Q15, small rules**: "blocks the most tickets" counts the tickets waiting on it directly or through others; the heartbeat's resource summary (05 section 3.3) is left out, since no rule uses it; GitHub's conditional requests (lot 3 step J, option C) are left out, since the GitHub check's requests stay far below GitHub's limit.
- **Q16, the real check**: step L as written below (three tickets over one night).

### When the owner's installed daemon stops working

Only if the owner chooses Q7 A (or Q8 A or Q13 needs it). From the step that raises `PROTOCOL_VERSION` to 3 (step F), a server built from `main` accepts the owner's installed 0.4.0 daemon as the previous version but marks the machine unusable ("Update the daemon on X"), as lot 3 did for 0.3.0: so neither **Run now** nor the scheduler starts runs on it. The release image of 0.4.0 is not affected. In step L the owner updates the daemon from Help > Machines > "Update the daemon" (the commands of lot 3, with `0.5.0`), then checks the machine page: online, usable, the same build as the server's.

### Lessons of lots 2 and 3, applied in every step

- **Time**: a test of the scheduler never waits for a real window, a real day or a real tick: the server's clock is the application's (`now`), moved by the test, and the loop is run by the test (`schedulerTick()`), as the CI loop's tests do (`ciTick()`). A test waits, with a deadline, for the observable effect (a row, a stream message, a daemon message), never for a delay (lot 2 step M, lot 3 step G1a).
- **One code path**: the loop and **Run now** share the account check, the candidate's checks and the machine choice; a test lists every refusal reason and shows both give it in the same words.
- **Every new item kind and event**: `merges.test.ts`'s every-kind guard and `every-event.ts` must cover each new "Needs you" item kind and event type (lot 3 steps H3, K2).
- **The owner's processes, CI duration, step size, rules 9 and 10**: as in lot 3 (test homes under `/tmp/od-test-*`, a shard over 8 minutes gets a new one, rule 15 splits, only the owner touches the real GitHub and Claude Code).
- **Claude usage**: every new automatic start is a cost the owner did not click for. Each step that adds one says in its summary what it can start by itself and how often at most, and the Help page of the feature says it in plain words.

## Steps

### [ ] A. Plan and spec decisions

- This plan; spec 10's lot 4 scope completed with lot 3's "Carried to lot 4"; CLAUDE.md's "Current state"; lot 3's plan marked tagged.
- After the owner's answers (second commit): the "Proposed" section above replaced by the answers, and the specs they change written: 01 (account fields, the held ticket), 02 (Needs you, Activity, accounts, Settings, project settings), 03 (criteria numbers, the `fix_review` message), 04 (sections 2 and 5.1, the reviews by themselves, Stop run), 05 (sections 3.3 and 6, `run.pause`), 06 (`ticket_submit`'s criteria), 07 (sections 1 to 8) and 10.

**Done when** the owner has approved this plan and the spec changes.

### [ ] B. Carried from lot 3

- **First, the flaky test** (own commit): `apps/server/test/conflicts-moved-head.test.ts` passes alone in 1.5 s but went over its 5 s timeout under the full suite's load in 3 runs of 3 (lot 3 step N): its cause found under load and fixed, or what was found recorded here.
- **A27 in the GitHub smoke test**: `github-smoke.sh` gains a step opening a pull request with a title of 256 characters and a description of 65,536 (`PULL_REQUEST_TITLE_MAX_LENGTH`, `PULL_REQUEST_BODY_MAX_LENGTH`), reading both back and closing it, with its branch deleted at the clean-up; `--only-a27` runs that step alone (Q16). GitHub documents neither limit (lot 3 step F3), so the fake GitHub accepts both and only the owner's run checks them.
- **Criteria numbers** (Q13): the first message, the review's message, `ticket_submit`'s report and its refusals (`agents/templates/submit-checks.md`) number criteria from 1; the server converts. The step first checks whether the 0.4.0 daemon reads the report's criteria (it measures the report's size): if it validates their numbers, the change waits for the protocol 3 raise of step F.
- **A request contradicting a criterion** (Q14): the dialog's sentence, the `fix_review` message's sentence (template `fix-review.md`), Help > Tickets > "Request changes".

**Done when** the flaky test passes 10 runs of 10 under the full suite's load (or its record is here); the smoke script's dry run passes A27 against the fake GitHub; tests read "criterion 1" in every agent-facing text and the refusals for a report naming criterion 0 or one past the last; Playwright on both viewports shows the dialog's sentence.

### [ ] C. Claude accounts: time zone, windows, budget, manual pause

- **The time zone** (Q6): stored once, set on Settings, filled in from the browser on first save; every window and "today" is read in it, daylight saving included (a window from 02:00 on the night the clocks go forward is a test).
- **Schedule windows** on the account (01 section 3.9): weekly windows (days, start, end; a window may cross midnight), none meaning always; **Behaviour at window end** (finish, or pause if Q7 A).
- **Daily budget** on the account: none, working time (minutes) or estimated usage (US dollars); what counts: working time as runs record it (05 section 5), estimated usage from Claude Code's `cost-state` (05 section 4.5); the day in the time zone of Q6.
- **Manual pause** (07 section 5.5): **Stop new runs** (state `paused_manual`) and **Resume**; **Pause now** comes in step F with `run.pause` (Q7). Run now's refusal for a paused account (Q5).
- **The screens**: Machines > Claude accounts (state, next window, time until reset, working time and estimated usage today against the budget, runs today, limit history from the `account.limited` events), the account status line on "Needs you" ("Paused", the next window), estimated usage per ticket (ticket page) and per day (account). Events for each change (01 section 3.10). Help > Machines > "Add a Claude account" (or a new section on accounts); CHANGELOG.
- Nothing starts by itself yet: these values are read by **Run now** (Q5) and, from step D, by the scheduler.

**Done when** server tests cover windows (crossing midnight, a daylight-saving change, none), the budget reached in each kind at the day's start and end, the manual pause and resume with their events, and Run now's refusals for each in the same words as the screens; Playwright on both viewports sets a window, a budget and a pause on an account and sees them on "Needs you" (screenshots).

### Step D: The scheduler (split proposed in three, rule 15)

The whole step: the loop of 07 section 2, the order of section 3, the machine choice of section 4, the blocking rule, the held ticket and the reviews by themselves. Proposed split, each in its own session:

### [ ] D1. The queue: who is next, and why not

- One function computes, from the database at a time `now`, every candidate (eligible `implement`, `fix_review`, `review` per Q1, quota resumes from step E) in order (07 section 3, Q15), and for each one not startable the reason, in words the screens share: no assignee, blocked by (named), stopped, held (Q4), a blocking item (named, Q3), the project archived or not ready, no token, the account (limited until, paused, outside its window until, budget used, at its maximum with the CI waits per Q2), no machine (each machine and why), the machine holding the work.
- **Run now**'s checks are rewritten on it, with no change of word or refusal (its tests unchanged).
- The API for the queue (Activity > Queue reads it in step H); no run is started by it.

**Done when** unit tests over a database built per case cover each order rule (category, priority, blocks-the-most, oldest, projects in turn) and each reason; Run now's existing tests pass unchanged.

### [ ] D2. The loop starts runs

- The loop (07 section 2): the advisory lock (a second server instance starts nothing, tested with two loops on one database), the triggers and **Scheduler check interval**, one run per account per pass until the account is full, the dispatch through Run now's path (`queued`, `dispatched`, the acknowledgement within **Machine answer timeout**; not acknowledged: cancelled, not counted, the ticket back in the queue, the machine skipped per Q3).
- The run's first message and comment say who started it ("Started by the scheduler"), and the event names the scheduler as actor (01 section 3.10, actor `system`).
- **The held ticket** (Q4): **Stop run** holds it; **Run now** releases it.
- **The blocking rule** (Q3): the existing blocking items (`ci_timeout`, `push_failed`, `download_failed`, "Review did not finish") are read by D1; `ci_cancelled`'s item if Q3 A, with its words.

**Done when** server tests with the real daemon and the fake `claude` show: two eligible tickets started in order on an account of maximum 1, the second after the first ends; a counted failure retried, then stopped at **Failed attempts before asking you**; each uncounted failure of Q3 never retried while its item stands; a stopped run's ticket held; a dispatch not acknowledged neither counted nor retried on the same machine before it reconnects; no run started twice by two loops.

### [ ] D3. Reviews and fixes by themselves

- **Reviews** (Q1): a ticket entering `in_review` becomes a `review` candidate (category 2) when its project's switch is on; **Skip review** before its start removes it; **Start review** moves it to the front; "Ready for review" says the review will start by itself (or that the switch is off).
- **Fixes**: after Quality's request for changes, and after the owner's **Request changes** (its confirmation's **Run now** stays, to move it to the front), the ticket is a `fix_review` candidate.
- The project settings page's switch, its event, Help > Tickets ("Review by Quality", "What starts by itself"), Help > Projects; CHANGELOG.

**Done when** server tests cover a ticket going `todo` → implement → `in_review` → review → `awaiting_merge` with no owner action, a request for changes followed by a `fix_review` by itself, **Skip review** before the review starts, and the switch off; Playwright on both viewports shows the switch and "Ready for review"'s sentence for both values.

### [ ] E. Quota: resuming by itself

- The scheduler resumes a run paused on a detected limit once `limited_until` has passed, first in its account's queue (07 section 5.2), only on the run's machine (lot 2's **Resume** rules: offline or unusable keeps it paused, with the reason in the queue).
- **The doubling**: a resume that pauses again on a limit with no reset time sets `limited_until` to now plus the doubled delay, up to **Longest quota wait**; the order rule between the two settings already exists (07 section 8). When the doubling restarts (Q9).
- **Suspected limits** (Q9).
- **Resume** by the owner stays; "Needs you" and Help > Runs > "Usage limits" lose "nothing resumes by itself" and say when it will resume.
- The fake `claude` already emits every signal (05 section 4.10); the server's clock is moved past `limited_until`.

**Done when** server tests with the real daemon and the fake `claude` cover: a detected limit with a reset time, resumed at that time and finishing; a limit with no time, resumed after 1 hour, limited again, then after 2 hours, then capped at **Longest quota wait**; a suspected limit per Q9; an account limited while two runs are paused, both resumed in order within its maximum; no failed attempt counted in any of them. Playwright: the paused run's item says when it resumes.

### [ ] F. Pausing a run (protocol 3)

Only if Q7 A; otherwise removed, and step C's manual pause is **Stop new runs** alone.

- `PROTOCOL_VERSION` 3 (rule 13): `run.pause` (server to daemon, acknowledged), the daemon closing the session and keeping the worktree and the Claude session id as at a quota pause (05 sections 4.7 and 4.10), the run `paused_quota` with a new pause reason (`owner_paused`, `window_ended`); a 0.4.0 daemon accepted as protocol 2 and unusable ("Update the daemon on X"), as lot 3 did for 0.3.0. Every change of B to E that a 0.4.0 daemon cannot understand joins this version.
- **Pause now** on the account (07 section 5.5): its active runs paused, resumed only by the owner (**Resume** on the account); a run waiting for the owner or waiting for CI is left as it is (it uses no quota).
- **Behaviour at window end** "pause": the account's working runs paused at the window's end, resumed by the scheduler when the next window opens.
- The resume's message is the "please continue" template (`agents/templates/continue.md`, 03 section 3.2), with a part saying why the run stopped.
- Help > Machines > "Update the daemon" (with 0.5.0) and the accounts section of step C, CHANGELOG.

**Done when** daemon tests pause a working run (its session closed, the worktree kept, the run's processes swept) and resume it with its session id; server tests cover **Pause now**, a window ending with each behaviour, and a 0.4.0 daemon marked unusable; Playwright on both viewports uses **Pause now** and **Resume**.

### [ ] G. Reconciliation after a disconnection

- The rest of 05 section 6: at `hello`, a run the server thinks active that the daemon does not report fails with `machine_offline` (not counted; a review run's ticket stays `in_review`), in the same transaction as the ticket's status; a run unknown to the server is stopped (lot 2, unchanged).
- **A machine offline too long** (Q10): the setting, which runs it applies to, the failure and its `system` comment (its words proposed in the step, saying the machine, how long it was offline and that it does not count); its daemon finding the run again at reconnection gets `run.stop` with `not_active`, and the end push and branch report it sends afterwards are kept (lot 3 step D2's ending window: checked here that an end push after such a failure is still accepted or refused as 05 section 7 says, with a test).
- The scheduler starts the ticket again only where 07 section 3's machine rule allows: commits not on GitHub keep it on the offline machine, so its queue line says "waiting for machine laptop (offline since …)".
- MCP calls while disconnected fail with a retryable error (05 section 6): checked, with a test if none exists.
- Help > Machines > Troubleshooting ("When a machine goes offline during a run"), Settings; CHANGELOG.

**Done when** daemon and server tests cover: a daemon stopped during a working run and back before the delay (the run continues), after the delay (failed, not counted, ticket in the queue or held to its machine, the session stopped at reconnection and its branch report kept), a daemon restarted with a run it no longer has (failed at `hello`), and a review run on a machine lost (ticket `in_review`, "Review did not finish").

### [ ] H. Activity > Queue and the run's waiting times

- Activity > **Queue** (02 section 7): per account its line, then each candidate in order with its reason (D1's words), live; **Run now** from a line; a held ticket's line says how to release it.
- The run page and Live runs: time waiting split between the owner, CI and the quota (07 section 7), from the run's status periods (01 section 3.7: waiting time already excludes `queued` and `dispatched`).
- Help > Activity (the queue, no longer "coming in a later version"), the sweep of `docs/user/` for "later version", "in this version" and "by itself" sentences about lot 4's work (activity.md, needs-you.md, runs.md, machines.md, tickets.md, settings.md's line 21); CHANGELOG.

**Done when** Playwright on both viewports shows the queue with a ticket waiting for a window, one blocked, one held, one on a limited account, and a run started from it, live without reload (screenshots); a web unit test covers each reason's words.

### [ ] I. Agents under their own system user

Only if Q11 B; otherwise left in lot 7 (10), and 05 section 7.2 and Help keep the known limit.

### [ ] J. End-to-end lot 4 test

- `apps/server/test/acceptance.test.ts` gains, with the real server, the real daemon, tmux, the fake `claude` and the fake GitHub, and the server's clock moved by the test:
  - scenario G: three tickets (one high priority, one blocked by another) on an account of maximum 1 with a window opening later: nothing before the window; then, with no owner action but the merges on the fake GitHub, each ticket implemented, reviewed (Q1) and `done` in the expected order, the blocked one after its blocker's merge;
  - scenario H: a usage limit with no reset time during a run: paused, the account limited, resumed by itself after the fallback delay, limited again and resumed after the doubled one, then submitted; no failed attempt;
  - scenario I: the daemon stopped during a run for longer than **Runs of an offline machine fail after**: the run failed, not counted, started again by the scheduler once the machine is back;
  - every process and folder of the test homes cleaned (lot 3 step M's checks).

**Done when** the three scenarios pass in `pnpm test`, within CI's 8 minutes per shard.

### [ ] K. Version 0.5.0

- Version 0.5.0 prepared (rule 14): every `package.json` and the `/version` test, a dated CHANGELOG section summing up lot 4, README.md's status line, CLAUDE.md's "Current state", the "(from version 0.5.0)" labels removed from `docs/user/settings.md` (its note then names only 0.6.0, plans).

**Done when** `pnpm verify` and `pnpm test:e2e` pass with 0.5.0 everywhere, and the owner's checklist of step L is written below.

### [ ] L. Lot 4 check by the owner

On the branch of step K, from `docs/user/` alone. The owner:

1. starts the server of this branch and, if the protocol changed (step F), updates the daemon with Help > Machines > "Update the daemon"; checks the machine page (online, usable, same build);
2. if Claude Code changed since 2.1.302: `claude-code-probe.sh` and `allowlist-smoke.sh` (`architect`, `quality`), as in lot 3;
3. runs `github-smoke.sh --repository <owner>/<test repository> --only-a27` (A27, step B; a few minutes, no Claude usage);
4. **in the evening**, in the `test 0.4.0` project (key `TESTB`, its skeleton CI): sets the time zone, a window on the account from about an hour later until 07:00, no budget, reviews by themselves on (Q1); creates three tickets (type **Documentation**, assignee **Web Developer**):
   - `TESTB-3` `Add a line about the scheduler to README.md`, priority normal, description `Add the line "Built while you sleep." at the end of README.md and commit it. Do nothing else.`, criterion `README.md ends with the line "Built while you sleep."`;
   - `TESTB-4` `Add a CONTRIBUTING.md file`, priority **high**, description `Create CONTRIBUTING.md containing the line "Open a ticket in the Orchestrator." and commit it. Do nothing else.`, criterion `CONTRIBUTING.md contains the line "Open a ticket in the Orchestrator."`;
   - `TESTB-5` `Link CONTRIBUTING.md from README.md`, priority normal, **blocked by** `TESTB-3`, description `Add the line "See [CONTRIBUTING.md](CONTRIBUTING.md)." at the end of README.md and commit it. Do nothing else.`, criterion `README.md ends with a link to CONTRIBUTING.md`;

   then checks Activity > **Queue** before leaving: `TESTB-4` first, `TESTB-3` next, both "waiting for the window at …", `TESTB-5` "blocked by TESTB-3". With **Stop new runs** on the account, the account's line says "Paused"; **Resume** it before leaving. Paste: the queue as shown.
5. **in the morning**: `TESTB-4` and `TESTB-3` **Awaiting merge**, each implemented then reviewed by Quality with no action of the owner, `TESTB-4` started first (its run page's start time); `TESTB-5` still waiting, "blocked by TESTB-3". The account page: working time and estimated usage of the night, runs today. Paste: both tickets' run lists, the account page's lines, any "Needs you" item.
6. merges both pull requests on GitHub; both **Done**; `TESTB-5`'s queue line now says "waiting for the window at …". Sets a budget of $0.01 of estimated usage on the account: the line says the budget is used for today (no session). Removes the budget and the window: `TESTB-5` starts by itself within **Scheduler check interval**. If step F was built: on its run page, **Pause now** on the account once it is **Running**, then **Resume** on the account: the run continues in the same session. Then: CI, review by itself, **Awaiting merge**, merge, **Done**. Paste: `TESTB-5`'s run page (status history) and README.md's last lines on GitHub.
7. **If the usage limit is reached** during the lot (the check or personal use; Q12): runs `tools/spike/claude-code-spike.sh --scan-limit`, and `--probe-limit` while the limit still shows, and pastes both; otherwise says so.

- **Quota** (estimates, from lot 3's measures: an implement run with no CI failure costs one session and one message; each message makes the agent take several steps):

  | Item | Sessions | Messages | Model |
  |---|---|---|---|
  | `TESTB-3`, `TESTB-4`, `TESTB-5`: implement | 3 | 3 | `sonnet` |
  | Their reviews, started by themselves | 3 | 3 | `sonnet` |
  | **Pause now** then **Resume** (only if step F was built) | 0 (same session) | +1 ("please continue") | `sonnet` |
  | Probe and allowlist smoke tests (only if Claude Code changed after 2.1.302) | 4 | 3 | `haiku` |
  | `--probe-limit` (only while limited: refused at no cost) | 1 | 1 | `sonnet` |

  In all: **6 `sonnet` sessions with 6 messages** (7 with step F), each reminder adding 1, and each request for changes by Quality 2 sessions and 2 messages. The lighter variant (Q16 B) drops `TESTB-5`: 4 `sonnet` sessions, 4 messages (5 with step F), the blocked ticket then covered by scenario G only.
- **A pass**: the three tickets `done` in the expected order with nothing started by the owner after the evening; no run started outside the window; the queue's reasons true at each step; no failed attempt; nothing on GitHub but the merged pull requests (and A27's closed one, its branch deleted).
- Gaps found are fixed, each with its test; results recorded here.

**Done when** the owner has run the scenario from the user documentation alone and confirmed it, and lot 4 is closed as version 0.5.0.

## Carried from lot 3, where each item went

| Item of lot 3's "Carried to lot 4" | Where |
|---|---|
| A27 in the GitHub smoke test | Step B; run by the owner in step L |
| A failure not counted leaves a blocking item, never retried in a loop | Decisions (already decided); built in D1 and D2 (Q3) |
| When reviews start by themselves | Q1; step D3 |
| Whether waiting for CI counts against the account's maximum | Q2; step D1 |
| **Push again** | Q8: left out of lot 4, moved to lot 7 (recommended); built with step F's protocol 3 if chosen |
| Criteria numbered from 0 | Q13; step B (with step F if the daemon reads them) |
| A request contradicting a criterion | Q14; step B |

Also from lot 3 and spec 10, outside that list: agents under a separate system user (Q11; step I or lot 7), the usage-limit signal capture (Q12; step L or lot 7), GitHub's conditional requests (lot 3 step J's option C; Q15), the heartbeat's resource summary (05 section 3.3; Q15), the flaky test of lot 3 step N (step B).

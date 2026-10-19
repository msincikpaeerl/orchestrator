# Lot 4 — Implementation plan

> Status: steps A to C and D1 done (2026-10-19; step A: the plan and the spec changes approved, the two new questions answered); step D2 split in D2a and D2b (owner, 2026-10-20); next: step D2a
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
- **Schedule windows, daily budget, behaviour at window end (finish, Q7), manual pause (Q7)** (07, sections 5.3 to 5.5; 01, section 3.9; 02, section 9.1): set on the Claude account. The budget is working time or estimated usage; once used up, no new run starts that day and the active one finishes. Estimated usage is shown per run, per ticket and per day. The account's state `paused_manual` already exists in the database's check constraint (lot 2).
- **What the owner sees** (07, section 7; 02, sections 4, 7 and 9.1): per account its state, next window, time until reset, working time and estimated usage today against the budget, runs today, and the history of limits reached; Activity > **Queue** with the next candidates and why each is not running ("waiting for window at 00:00", "no machine with android-sdk", "blocked by WEB-3"); per run the time working and the time waiting, split between the owner, CI and the quota. The account status line on "Needs you" gains "Paused" and the next window.
- **Reconciliation** (05, section 6): the daemon is the source of truth for processes, the server for tickets; at `hello` a run unknown to the server is stopped (lot 2) and a run the server thinks active that the daemon does not report fails with `machine_offline`; a run whose machine stays offline too long fails and follows the retry policy (the delay: Q10).
- **The blocking rule** (10, lot 4; 04, section 5.1): a failure that is not counted (`ci_timeout`, `push_failed`, `download_failed`, a review run that did not finish) leaves a blocking "Needs you" item, and the scheduler never starts that ticket again while the item stands. A counted failure returns the ticket to the queue behind the other candidates of its category (07, section 6), until **Failed attempts before asking you** stops it (lot 3 step K1).
- **Settings marks**: **Scheduler check interval** and **Longest quota wait** lose their "Used from version 0.5.0" in step L (rule 14); **Most tickets per plan** (0.6.0) keeps its mark and stays the one `settings.e2e.ts` checks.

### The owner's answers (2026-10-18)

Step A's questions (Q), answered by the owner; the specs named carry them (step A's second commit).

- **Q1, reviews and fixes by themselves: A** (07 section 1, 04 section 2, 01 section 3.1, 02 sections 4 and 6.5): the scheduler starts a `review` run when a ticket enters `in_review` with a pull request, and a `fix_review` run after a request for changes (Quality's or the owner's), with a per-project switch **Start reviews by themselves** (on by default) on the project settings page. **Skip review** stays possible until the review run starts. **Start review** and the **Request changes** confirmation's **Run now** move the run to the front.
- **Q2, waiting for CI: A** (07 section 3): a run waiting for CI keeps counting against its account's maximum concurrent runs.
- **Q3, uncounted failures: A, with the owner's condition** (04 section 5.1, 07 section 4, 01 section 3.4, 02 section 4): `ci_cancelled` gets a blocking item too. The failures the machine caused leave no item at once; the specs now say, for each, what keeps its machine out of the scheduler's choice and until when (checked in the code in step A): `machine_offline` until it reconnects, `machine_revoked` for ever, `claude_code_unsupported` until a supported version is reported (the machine is marked unusable in the failure's transaction), `machine_problem` until the daemon restarts (the daemon reports the scope error at once, as a second message: a start sent between the two is refused by the daemon). **A dispatch not acknowledged, or refused, can leave the machine usable**, so the rule proposed in 07 section 4 (for the owner's review, new question 1 below): after one such failure the scheduler does not start that ticket on that machine again until the machine connects again or the owner's **Run now**; after a second one in a row for the same ticket on the same machine, a blocking item "<ticket> could not start on <machine>" with **Run now**. Step D2 tests it for each of the five.
- **Q4, Stop run: A** (04 section 2, 07 section 1, 01 section 3.4, 02 section 6.4): the ticket is **held** from the scheduler until the owner's **Run now** ("Held: you stopped its run"); a stopped review run holds its ticket until **Start review**.
- **Q5, Run now and the account: A** (07 section 3): Run now ignores schedule windows and the daily budget, and refuses an account paused, limited or at its maximum.
- **Q6, time zone: A** (07 section 5.3, 02 section 10): one time zone for the Orchestrator, on Settings, filled in from the browser; it reads the windows, the budget's day and "runs today".
- **Q7, pausing a run: B** (07 sections 5.3 and 5.5, 02 section 9.1, 10): no `run.pause` and no protocol raise in lot 4. The manual pause is **Stop new runs** and **Resume**; a window's end lets the current run finish. **Pause now** and the pause at a window's end stay in 07, kept for later (no lot plans them yet). **Stop run** with the held ticket (Q4) frees the quota at once. Step F is removed.
- **Q8, Push again: A** (04 section 5.1, 10): moved to lot 7, with lot 3's design.
- **Q9, suspected limits: A** (07 section 5.2): the scheduler resumes such a run after **Quota wait when the reset time is unknown**, doubled for the same run each time it pauses again, up to **Longest quota wait**; the account is unchanged; the doubling restarts once the resumed run ends a turn without a limit.
- **Q10, an offline machine's runs: A** (05 section 6, 07 section 8): a new global setting **Runs of an offline machine fail after** (`offlineRunFailMinutes`, 10 minutes, 1 to 1,440) for runs `dispatched`, `starting` and `running` (waiting for CI included); runs waiting for the owner or paused keep waiting.
- **Q11, agents under their own system user: A** (05 section 7.2, 10): stays in lot 7.
- **Q12, usage-limit capture: A** (10): if the limit is reached during lot 4, the owner runs `--scan-limit` and `--probe-limit`; otherwise the capture moves to lot 7.
- **Q13, criteria numbers: A, with its fallback B for lot 4** (03 section 3.2, 06 section 4.2, 10). Step A found the case the owner named: the daemon's MCP relay lists the tools with their descriptions and input schemas from its own copy of `packages/protocol`, and `ticket_submit`'s says "by index, from 0". A 0.4.0 daemon, still accepted by a 0.5.0 server, would keep telling agents to count from 0, so numbering from 1 in the tool needs every daemon updated, which Q7 B excludes. So in lot 4: the index stays 0 in the tool; agents are told to write criterion numbers from 1 in every text the owner reads; a text for the agent that the owner also reads (a refusal on the run page) names both. Numbering from 1 in the tool can come with lot 7's daemon update (Push again).
- **Q14, a request contradicting a criterion: A** (04 section 2, 03 section 3.1, 02 section 6.4): the **Request changes** dialog says to edit the criteria too (the ticket is **To do** afterwards, so **Edit** is offered), Help says so, and the `fix_review` message says the owner's request comes after the criteria. With Q1, the fix run can start before the owner edits them: new question 2 below.
- **Q15, small rules: a) A, b) A, c) A** (07 section 3, 05 section 3.3): "blocks the most tickets" counts the tickets waiting on it directly or through others; the heartbeat's resource summary is left out; GitHub's conditional requests (lot 3 step J, option C) are left out.
- **Q16, the real check: A** (step L): three tickets over one night, without a **Pause now** part.
- **Q17**: the owner's architect allowlist rerun before the tag (Claude Code 2.1.302, `haiku`, 2026-10-18T17:14:14.594Z): 17 of 17 PASS, recorded in lot 3's plan (step N).

**New questions from writing the answers**, answered by the owner (2026-10-19, with the approval of PR #83; written into the specs named in step B's first commit):

1. **How many machine-caused failures in a row block a ticket** (Q3's rule): **the recommended setting** (04 section 8, 07 sections 4 and 8): **Machine failures before asking you** (`maxMachineFailures`), 2 by default, 1 to 10, global (machines are not a project's; 04 section 8 lists it with "No" override), on Settings > Limits with "Used from version 0.5.0"; read at the failure that reaches it. Built in step D2.
2. **The fix run starting before the owner edits a criterion** (Q1 with Q14): **the recommended box** (01 section 3.4, 02 sections 6.4, 04 section 2, 07 section 1): the **Request changes** dialog has "Hold <ticket> so I can edit its acceptance criteria first", unchecked by default; checked, it holds the ticket as **Stop run** does (Q4) until the owner's **Run now**, and the confirmation offers no **Run now**. Built in **step D2**, with the hold it uses: in step B the box would need the hold built first (its field, events, badge and release, a part of D2 moved before any scheduler that reads it, rule 5), while in D2 it is one more way to set the hold.

### No daemon update expected in lot 4

Lot 4 raises no `PROTOCOL_VERSION` (Q7 B, Q8 A, Q13's fallback): the owner's installed 0.4.0 daemon stays usable with a server built from `main`, which shows it as "The daemon on X is not the one this Orchestrator provides" (a different build of the same protocol, not blocking; 02 section 4). Every step keeps a 0.4.0 daemon working, and tests it where it changes something the daemon reads. A step that finds a daemon change unavoidable stops and asks the owner before writing it.

### Lessons of lots 2 and 3, applied in every step

- **Time**: a test of the scheduler never waits for a real window, a real day or a real tick: the server's clock is the application's (`now`), moved by the test, and the loop is run by the test (`schedulerTick()`), as the CI loop's tests do (`ciTick()`). A test waits, with a deadline, for the observable effect (a row, a stream message, a daemon message), never for a delay (lot 2 step M, lot 3 step G1a).
- **One code path**: the loop and **Run now** share the account check, the candidate's checks and the machine choice; a test lists every refusal reason and shows both give it in the same words.
- **Every new item kind and event**: `merges.test.ts`'s every-kind guard and `every-event.ts` must cover each new "Needs you" item kind and event type (lot 3 steps H3, K2).
- **The owner's processes, CI duration, step size, rules 9 and 10**: as in lot 3 (test homes under `/tmp/od-test-*`, a shard over 8 minutes gets a new one, rule 15 splits, only the owner touches the real GitHub and Claude Code).
- **Claude usage**: every new automatic start is a cost the owner did not click for. Each step that adds one says in its summary what it can start by itself and how often at most, and the Help page of the feature says it in plain words.

## Steps

### [x] A. Plan and spec decisions (2026-10-19)

- This plan; spec 10's lot 4 scope completed with lot 3's "Carried to lot 4"; CLAUDE.md's "Current state"; lot 3's plan marked tagged.
- After the owner's answers (second commit, 2026-10-18): the answers above, and the specs they change: 01 (the project's switch, the held ticket, the machine-caused failures, the account's windows, budget and paused state), 02 (Needs you's new items and lines, the held badge, the dialog's sentence, project settings, Activity > Queue, the run's waiting split, the account page, Settings' time zone), 03 (criteria numbers, the `fix_review` message), 04 (sections 2 and 5.1: the scheduler's guard, Stop run's hold, the fix by itself, the contradicting request, `ci_cancelled`'s item, Push again moved), 05 (sections 3.3, 6 and 7.2), 06 (`ticket_submit`'s index), 07 (sections 1 to 8) and 10 (lots 4 and 7); lot 3's plan records the allowlist rerun (Q17).

**Done when** the owner has approved this plan and the spec changes, and answered the two new questions (their answers written in the same way).

### [x] B. Carried from lot 3 (2026-10-19)

- **First, the flaky test** (own commit): `apps/server/test/conflicts-moved-head.test.ts` passes alone in 1.5 s but went over its 5 s timeout under the full suite's load in 3 runs of 3 (lot 3 step N): its cause found under load and fixed, or what was found recorded here.
- **A27 in the GitHub smoke test**: `github-smoke.sh` gains a step opening a pull request with a title of 256 characters and a description of 65,536 (`PULL_REQUEST_TITLE_MAX_LENGTH`, `PULL_REQUEST_BODY_MAX_LENGTH`), reading both back and closing it, with its branch deleted at the clean-up; `--only-a27` runs that step alone (Q16). GitHub documents neither limit (lot 3 step F3), so the fake GitHub accepts both and only the owner's run checks them.
- **Criteria numbers** (Q13's fallback, 03 section 3.2): `ticket_submit`'s index stays from 0, since the daemon serves the tool's description from its own copy; the common rules and the templates (first message, review, `fix-review.md`, `submit-checks.md`) tell agents to write criterion numbers from 1 in every text the owner reads (comments, questions, a give-up's reason, review points, the report's justifications); the refusals shown on the run page name both ("criterion 1, index 0").
- **A request contradicting a criterion** (Q14): the dialog's sentence, the `fix_review` message's sentence (template `fix-review.md`), Help > Tickets > "Request changes".

**Done when** the flaky test passes 10 runs of 10 under the full suite's load (or its record is here); the smoke script's dry run passes A27 against the fake GitHub; tests read the sentence about numbers from 1 in the rules and each template, and both numbers in the refusals for a report naming a missing criterion, one not met and one past the last; Playwright on both viewports shows the dialog's sentence.

*Done 2026-10-19*, in one session (no split needed):

- **The flaky test**: reproduced with the file run repeatedly beside a full `pnpm test`: 5 runs of 12 failed, always the first case ("is read once per interval…", two submissions with CI, a review and a fix run's start) at Vitest's 5 seconds. Timed phase by phase under load, its time is spread over every step (server start 0.7 to 1 s, each submission 0.8 to 1.5 s, the review 0.3 to 0.8 s, the ticks 0.6 s), with no wait or poll among them: every case of the file ran about three times slower (0.5 to 1.7 s alone, up to 5.8 s loaded; the others up to 4.1 s). Plain slowness, so a measured 15-second deadline per case (`SCENARIO`), no assertion changed: 11 runs of 11 passed under the same load. Seen meanwhile under that doubled load only (the suite plus this file), in 2 suites of 4: `runner.test.ts` (idle timeout), `workspace.test.ts` (local commits across runs) and `fix-review.test.ts` (a full round) failed once each; none failed in the plain `pnpm verify` runs of this step. Recorded, not changed.
- **A27**: step 12 of `github-smoke.sh` (`apps/server/scripts/github-smoke.ts`): a branch `orchestrator-smoke-<time>-long-text` with one commit, a pull request whose title is 256 characters and description 65,536, both holding a zero-width space and the marker `…` (the characters beyond ASCII the Orchestrator's texts hold, in case GitHub counts bytes), read back whole, closed at once; the clean-up deletes the branch (A35 read as usual). It runs in the full run after step 11 (the script's confirmation now says six pull requests and 10 CI runs) and alone with `--only-a27` (no token check, no merge settings, no other step; refused with `--restricted-token`; the result block lists step 12, A27 and A35). It costs 1 CI run, not waited for. Tests: the full dry run (A27 and step 12 PASS), `--only-a27` (texts whole on the fake, only three writes), GitHub refusing the texts and reading the description back shorter (A27 FAIL with the first difference, the clean-up still done), and the refused combination.
- **Criteria numbers**: a paragraph of the common rules, every role; `implement` and `fix-review` say under "Acceptance criteria" to use the numbers from 1 and that the index counts from 0, and list "- Criterion 1 (index 0): …"; `review` the same without naming `ticket_submit` (its texts never do, lot 3 step H5), the agent's report as "- Criterion 1 (index 0), met: …"; `submit-checks` names both in its refusals, including past the last ("your report names criterion 6 (index 5), which the ticket does not have") and a new sentence for a ticket without criteria. `ticket_submit`'s description and schema unchanged: nothing the 0.4.0 daemon reads changed (it relays the first message and the refusals as text).
- **A request contradicting a criterion**: the dialog's sentence ("If your request contradicts one of the acceptance criteria, edit that criterion too: once WEB-12 is back in To do, use Edit on its page. Until then, the agent does what your request asks and says so when it reports on that criterion."), the same words in Help (a unit test reads them there), and the `fix_review` message after the owner's request only: "The owner wrote this request after the acceptance criteria below, so it comes first: …". **For the owner's review**: answer 14's "comes after the criteria" is read as "newer, so it wins where they disagree", as the agent did in lot 3's check.
- **New question 2's box** goes to step D2 (written in step A's record): no code for it here.

### [x] C. Claude accounts: time zone, windows, budget, manual pause (2026-10-19)

- **The time zone** (Q6): stored once, set on Settings, filled in from the browser on first save; every window and "today" is read in it, daylight saving included (a window from 02:00 on the night the clocks go forward is a test).
- **Schedule windows** on the account (01 section 3.9): weekly windows (days, start, end; a window may cross midnight), none meaning always. A window's end lets the current run finish, the only behaviour (Q7 B): the account shows no **Behaviour at window end**.
- **Daily budget** on the account: none, working time (minutes) or estimated usage (US dollars); what counts: working time as runs record it (05 section 5), estimated usage from Claude Code's `cost-state` (05 section 4.5); the day in the time zone of Q6.
- **Manual pause** (07 section 5.5): **Stop new runs** (state `paused_manual`, active runs finish) and **Resume**, on the account page and its line on "Needs you"; no **Pause now** (Q7 B). Run now's refusal for a paused account (Q5); Help says that **Stop run** frees the quota at once and holds the ticket (Q4).
- **The screens**: Machines > Claude accounts (state, next window, time until reset, working time and estimated usage today against the budget, runs today, limit history from the `account.limited` events), the account status line on "Needs you" ("Paused", the next window), estimated usage per ticket (ticket page) and per day (account). Events for each change (01 section 3.10). Help > Machines > "Add a Claude account" (or a new section on accounts); CHANGELOG.
- Nothing starts by itself yet: these values are read by **Run now** (Q5) and, from step D, by the scheduler.

**Done when** server tests cover windows (crossing midnight, a daylight-saving change, none), the budget reached in each kind at the day's start and end, the manual pause and resume with their events, and Run now's refusals for each in the same words as the screens; Playwright on both viewports sets a window, a budget and a pause on an account and sees them on "Needs you" (screenshots).

*Done 2026-10-19*, in one session (no split needed):

- **First, a gap of answer 14** (owner's request with the review of step B): the `review` run's first message, after an owner's **Request changes** answered by the fix, says under the acceptance criteria that the request was written after them and wins where they disagree, so a criterion the agent reported as superseded by it is no reason to request changes (template `review.md`, part `owner-request-first`; absent after Quality's request or none); specs 03 and 04 section 2, Help > Tickets, CHANGELOG.
- **Time zone**: one row (`time_zone`), `GET`/`PUT /api/time-zone`, event `setting.time_zone_saved`; **UTC until the owner's first save**, said on Settings and on each account page; Settings > Time zone fills in the browser's zone. Windows and days use `Intl` (Node.js's ICU data), no new dependency: a time the clocks skip moves forward by the gap (a window from 02:00 opens at 03:00), a window inside the gap is empty that night, a time shown twice is its first occurrence. The tests move the clock by giving `now` as UTC instants on both sides of the changes of 2026-03-29 and 2026-10-25 in Europe/Paris (unit tests of `schedule.ts`; the server tests pass the application's clock, `now`, set per case).
- **Budget's day**: each run counts whole on the day it started; a run in progress with its working time up to now and the latest estimate its machine sent with its log (`run.events`'s `estimatedUsageUsd`, sent by daemons since 0.3.0, so a 0.4.0 daemon is enough); a run with no estimate counts $0.00 and the screens say how many. A run started at 23:50 stays on that day.
- **Stop new runs / Resume**: `account.paused` and `account.resumed`; Run now refused (`account_paused` per machine) and **Resume** of a paused run too (refusal `account_paused`), in the words "you stopped new runs on it" shared with the screens. A detected limit while paused keeps `paused_manual` with `limited_until`; Resume returns to `limited` until then.
- **Screens**: the account card on Machines (state with time left, window, today against the budget, the budget used, **Edit**, **Stop new runs**/**Resume**, link "Windows, budget and history"); the account page `/machines/accounts/:id` (windows and budget editors, 14 days, latest 20 limits); "Needs you"'s account line (Paused, next window, budget used, the button); the ticket page's estimated usage of its runs. The account screens and "Needs you" read again every minute (window and day move with the clock).
- Nothing starts by itself; no daemon change, no protocol raise.

### Step D: The scheduler (split proposed in three, rule 15; D2 split again in two)

The whole step: the loop of 07 section 2, the order of section 3, the machine choice of section 4, the blocking rule, the held ticket and the reviews by themselves. Proposed split, each in its own session:

### [x] D1. The queue: who is next, and why not (2026-10-19)

- One function computes, from the database at a time `now`, every candidate (eligible `implement`, `fix_review`, `review` per Q1, quota resumes from step E) in order (07 section 3, Q15), and for each one not startable the reason, in words the screens share: no assignee, blocked by (named), stopped, held (Q4), a blocking item (named, Q3), the project archived or not ready, no token, the account (limited until, paused, outside its window until, budget used, at its maximum, CI waits included per Q2), no machine (each machine and why, a machine left out for this ticket after a failure it caused included, 07 section 4), the machine holding the work.
- **Run now**'s checks are rewritten on it, with no change of word or refusal (its tests unchanged).
- The API for the queue (Activity > Queue reads it in step H); no run is started by it.

**Done when** unit tests over a database built per case cover each order rule (category, priority, blocks-the-most, oldest, projects in turn) and each reason; Run now's existing tests pass unchanged.

*Done 2026-10-19*, in one session (no split needed):

- **First, the owner's Help sentence** (review of step C): Help > Machines > "Keep Claude usage for yourself" says the budget is per calendar day, so a window from 22:00 to 06:00 can use two days' budget in one night, and to start the window at 00:00 to cap a night with one budget. No code change.
- **The shared checks** (`apps/server/src/scheduler/checks.ts`, pure functions): GitHub's connection, the project, the ticket, the account (paused, limited, then for the scheduler only outside its window and budget used, then at its maximum, runs waiting for CI included per Q2), each machine, the machine holding the work, the machine choice and preference, Resume's checks. **Run now**, **Start review** and **Resume** call them under their locks, as before: no refusal and no message changed, and their tests pass unchanged (`runs`, `accounts`, `review-start`, `failed-attempts`, `fix-review`). One change of behaviour, written in 07 section 4: "the fewest runs today" counts from midnight in the Orchestrator's time zone, not UTC's.
- **The queue** (`scheduler/queue.ts`, `GET /api/queue`, schema `QueueResponse`): every candidate at `now` in order, each with its reason or the machine it would start on, walked as the loop will start them (one account place each); each account's line. The precise order and what "oldest" is are written in 07 section 3 (**for the owner's review**: a counted failure goes behind the others of its category before priority, as 07 section 6 says; projects in turn by their latest run's age). Reading it starts nothing; no daemon message changed (a 0.4.0 daemon is unaffected).
- **The reasons and their words**, in `QueueReason` and the web's `queueReasonText` (`apps/web/src/runs/text.ts`, tested for every reason): Run now's words for Run now's reasons, and those only the scheduler gives: "its Claude account Personal is outside its window until …", "… has used its daily budget for today, until …", "Held: you stopped its run. Run now releases it and starts it." (and for a stopped review, and the Request changes hold box), "Waiting for you in Needs you: …" for each blocking item, a machine "left out for this ticket since …, when <the failure>, until it connects again or you use Run now". So D2 to H add no words.
- **How D1 reads what D2 writes** (no table or column added for D2): the blocking items `ci_timeout`, `push_failed` and `download_failed` are read with "Needs you"'s own functions, and "Review did not finish" with the ticket's review; **`ci_cancelled`** is read as "the ticket's latest run ended `ci_cancelled`", the rule of `download_failed`'s item, which D2's item must keep. **Held**, the **machine left out** for a ticket and the item **"<ticket> could not start on <machine>"** have their reasons and words, and are wired in D2, which adds the hold's field (01 section 3.4) and what records a machine's reconnection: today only the `machine.online` events say when a machine connected, with the real clock, not the application's clock the tests move.
- **What the loop must not start yet**: resumes are listed with Resume's checks (plus windows and the budget); the waits of a suspected limit (Q9) and the doubling are step E's, so D2's loop leaves resumes to E. Reviews are listed whenever "Ready for review" is offered; the project's switch is step D3's.
- **How long it takes**: about 20 ms for 5 projects and 200 eligible tickets (one or two runs each, a dependency every fourth ticket, two machines), median of 5 computations in each of 3 runs on the owner's machine (17 to 24 ms each), about 20 queries whatever the number of tickets, plus 3 for each ticket in review. At every 30 seconds and every relevant event, it is negligible. A test computes that queue and checks it stays under 5 seconds (CI under load).
- **Tests**: `apps/server/test/queue.test.ts` (14 cases, a database per case, the clock given as `now`): each order rule (category, priority, blocks the most directly and through others, oldest, a counted failure behind, projects in turn, the account's places taken in order) and each reason (no assignee, stopped, blocked by named tickets, archived, not ready, GitHub token missing, unreadable or refused, the four blocking items and one gone after a new run, review not finished, account paused, limited and its time passed, outside its window and inside, budget used, machines offline, disabled, missing a capability, none, the machine holding the work, a paused run's machine, a paused run's account limited), and the 200-ticket queue; `queue-run-now.test.ts` (the real application): the queue and Run now give the same reason for no assignee, blocked, a paused account, an account at its maximum and an offline machine, the queue starting nothing; only the owner reads it; web unit tests for every reason's words.

### Step D2: the loop starts runs (split in two by the owner, rule 15, review of step D1)

The whole step, as first planned: the loop of 07 section 2, the dispatch through Run now's path, who started the run, the held ticket (Q4), the blocking rule (Q3), the failures the machine caused (Q3's condition, new answer 1), the Request changes hold box (new answer 2). The owner split it in two, each in its own session and pull request (review of step D1, 2026-10-20). Two answers of that review apply to both: the order of 07 section 3 stays as written (a counted failure behind the others of its category, even ahead of priority; projects in turn; oldest = waiting longest), and D2's loop does not resume paused runs (step E does) and starts a review whenever "Ready for review" is offered, until D3's switch. One addition: a ticket blocked by a cancelled ticket stays blocked (as Run now keeps it), and its reason says so, in the queue and in Run now's refusal: "blocked by WEB-3 (cancelled): remove the dependency to let it start" (built in D2a, with a test).

**No main commit may start runs in a loop** (owner, review of step D1): D2a alone must not start a stopped run's ticket again, nor send a dispatch not acknowledged to the same machine at every pass; it adds the minimal guard for each (or keeps the loop off until D2b) and says which. Each part's summary says what the loop can start by itself and how often at most ("Claude usage" above).

### [ ] D2a. The loop (branch `lot4/d2a-loop`)

- The loop (07 section 2): the advisory lock (two loops on one database start nothing twice), the triggers and **Scheduler check interval**, one run per account per pass until the account is full, the dispatch through Run now's path (`queued`, `dispatched`, the acknowledgement within **Machine answer timeout**; not acknowledged or refused: cancelled, not counted, the ticket back in the queue).
- "Started by the scheduler" in the run's first message and in its comment, and the scheduler (actor `system`) in the run's events (01 section 3.10).
- A counted failure retried, then stopped at **Failed attempts before asking you** before asking the owner (lot 3 step K1's stop, unchanged).
- The existing blocking items read by D1 (`ci_timeout`, `push_failed`, `download_failed`, "Review did not finish", and `ci_cancelled` read as the latest run's end): their ticket is never started again while the item stands.
- The minimal guards D2a needs until D2b (above), each replaced or confirmed by D2b.
- The blocked-by-a-cancelled-ticket reason (above).

**Done when** server tests show: two eligible tickets started in order on an account of maximum 1, the second once the first ends, with no owner action; two loops on one database starting nothing twice; the triggers and the interval; a dispatch not acknowledged or refused cancelled, not counted and not sent again to that machine at every pass; a stopped run's ticket not started again by the loop until **Run now**; a counted failure retried, then stopped at **Failed attempts before asking you**; each existing blocking item keeping its ticket out of the loop; "Started by the scheduler" in the first message and the comment, the events' actor `system`; the cancelled blocker's words in the queue and in Run now's refusal (a web unit test for the words).

### [ ] D2b. Holds and the machine's failures (branch `lot4/d2b-holds`, next session)

- **The held ticket** (Q4): **Stop run** holds it; **Run now** releases it (**Start review** for a review run); the badge and the ticket page's sentence (02 section 6.4).
- **The Request changes hold box** (new answer 2): "Hold <ticket> so I can edit its acceptance criteria first", unchecked by default; checked, the request holds the ticket as **Stop run** does and the confirmation offers no **Run now**; Help > Tickets > "Request changes".
- **Failures the machine caused** (Q3's condition, 07 section 4): the machine left out for the ticket after one, until its next `hello` or the owner's **Run now**, with the reconnection record that rule needs (today only `machine.online` events, on the real clock); the item "<ticket> could not start on <machine>" once **Machine failures before asking you** (new answer 1; 2 by default) are reached in a row, with its words; the setting on Settings > Limits ("Used from version 0.5.0" until step K), Help > Settings and the settings tests.
- **The blocking rule** (Q3): `ci_cancelled`'s own item, with its words.
- The every-kind and every-event guards cover the two new items and the hold's events.

**Done when** server tests with the real daemon and the fake `claude` show: a stopped run's ticket held, and released by Run now; for each of the five machine-caused failures (`machine_offline`, `machine_revoked`, `claude_code_unsupported`, `machine_problem`, a dispatch not acknowledged or refused), the same ticket never started again on that machine in a loop: left out until the machine reconnects, then the item after a second failure in a row (after the first with **Machine failures before asking you** at 1), with a start sent between a `machine_problem` end and its `machine.doctor` report refused and not looping; `ci_cancelled`'s item; a **Request changes** with its hold box checked leaves the ticket held, never started by the loop, until **Run now**, and one without the box does not (Playwright on both viewports shows the box).

### [ ] D3. Reviews and fixes by themselves

- **Reviews** (Q1): a ticket entering `in_review` becomes a `review` candidate (category 2) when its project's switch is on; **Skip review** before its start removes it; **Start review** moves it to the front; "Ready for review" says the review will start by itself (or that the switch is off).
- **Fixes**: after Quality's request for changes, and after the owner's **Request changes** (its confirmation's **Run now** stays, to move it to the front), the ticket is a `fix_review` candidate, unless the dialog's hold box (new answer 2, built in D2) held it.
- The project settings page's switch, its event, Help > Tickets ("Review by Quality", "What starts by itself"), Help > Projects; CHANGELOG.

**Done when** server tests cover a ticket going `todo` → implement → `in_review` → review → `awaiting_merge` with no owner action, a request for changes followed by a `fix_review` by itself, **Skip review** before the review starts, and the switch off; Playwright on both viewports shows the switch and "Ready for review"'s sentence for both values.

### [ ] E. Quota: resuming by itself

- The scheduler resumes a run paused on a detected limit once `limited_until` has passed, first in its account's queue (07 section 5.2), only on the run's machine (lot 2's **Resume** rules: offline or unusable keeps it paused, with the reason in the queue).
- **The doubling**: a resume that pauses again on a limit with no reset time sets `limited_until` to now plus the doubled delay, up to **Longest quota wait**; the order rule between the two settings already exists (07 section 8). The doubling restarts once a run of the account ends a turn without a limit (07 section 5.2).
- **Suspected limits** (Q9): resumed after **Quota wait when the reset time is unknown**, doubled for the same run at each new pause, up to **Longest quota wait**, the doubling restarted once the run ends a turn without a limit; the account unchanged.
- **Resume** by the owner stays; "Needs you" and Help > Runs > "Usage limits" lose "nothing resumes by itself" and say when it will resume.
- The fake `claude` already emits every signal (05 section 4.10); the server's clock is moved past `limited_until`.

**Done when** server tests with the real daemon and the fake `claude` cover: a detected limit with a reset time, resumed at that time and finishing; a limit with no time, resumed after 1 hour, limited again, then after 2 hours, then capped at **Longest quota wait**; a suspected limit resumed after 1 hour, paused again and resumed after 2, then a turn ending without a limit and the next pause waiting 1 hour again; an account limited while two runs are paused, both resumed in order within its maximum; no failed attempt counted in any of them. Playwright: the paused run's item says when it resumes.

### F. Pausing a run: removed

Removed by the owner's answer Q7 B: no `run.pause` and no protocol raise in lot 4. **Pause now** and the pause at a window's end stay in 07 (sections 5.3 and 5.5) for later; step C builds **Stop new runs** and **Resume**.

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

### I. Agents under their own system user: removed

Removed by the owner's answer Q11 A: it stays in lot 7 (10), and 05 section 7.2 and Help keep the known limit.

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

1. starts the server of this branch; the installed 0.4.0 daemon stays usable (no protocol change): the machine page shows it online and usable, with the warning that its build is not the one this Orchestrator provides (updating it with Help > Machines > "Update the daemon" is optional);
2. if Claude Code changed since 2.1.302: `claude-code-probe.sh` and `allowlist-smoke.sh` (`architect`, `quality`), as in lot 3;
3. runs `github-smoke.sh --repository <owner>/<test repository> --only-a27` (A27, step B; a few minutes, no Claude usage);
4. **in the evening**, in the `test 0.4.0` project (key `TESTB`, its skeleton CI): sets the time zone, a window on the account from about an hour later until 07:00, no budget, reviews by themselves on (Q1); creates three tickets (type **Documentation**, assignee **Web Developer**):
   - `TESTB-3` `Add a line about the scheduler to README.md`, priority normal, description `Add the line "Built while you sleep." at the end of README.md and commit it. Do nothing else.`, criterion `README.md ends with the line "Built while you sleep."`;
   - `TESTB-4` `Add a CONTRIBUTING.md file`, priority **high**, description `Create CONTRIBUTING.md containing the line "Open a ticket in the Orchestrator." and commit it. Do nothing else.`, criterion `CONTRIBUTING.md contains the line "Open a ticket in the Orchestrator."`;
   - `TESTB-5` `Link CONTRIBUTING.md from README.md`, priority normal, **blocked by** `TESTB-3`, description `Add the line "See [CONTRIBUTING.md](CONTRIBUTING.md)." at the end of README.md and commit it. Do nothing else.`, criterion `README.md ends with a link to CONTRIBUTING.md`;

   then checks Activity > **Queue** before leaving: `TESTB-4` first, `TESTB-3` next, both "waiting for the window at …", `TESTB-5` "blocked by TESTB-3". With **Stop new runs** on the account, the account's line says "Paused"; **Resume** it before leaving. Paste: the queue as shown.
5. **in the morning**: `TESTB-4` and `TESTB-3` **Awaiting merge**, each implemented then reviewed by Quality with no action of the owner, `TESTB-4` started first (its run page's start time); `TESTB-5` still waiting, "blocked by TESTB-3". The account page: working time and estimated usage of the night, runs today. Paste: both tickets' run lists, the account page's lines, any "Needs you" item.
6. merges both pull requests on GitHub; both **Done**; `TESTB-5`'s queue line now says "waiting for the window at …". Sets a budget of $0.01 of estimated usage on the account: the line says the budget is used for today (no session). Removes the budget and the window: `TESTB-5` starts by itself within **Scheduler check interval**. Then: CI, review by itself, **Awaiting merge**, merge, **Done**. Paste: `TESTB-5`'s run page (status history) and README.md's last lines on GitHub.
7. **If the usage limit is reached** during the lot (the check or personal use; Q12): runs `tools/spike/claude-code-spike.sh --scan-limit`, and `--probe-limit` while the limit still shows, and pastes both; otherwise says so.

- **Quota** (estimates, from lot 3's measures: an implement run with no CI failure costs one session and one message; each message makes the agent take several steps):

  | Item | Sessions | Messages | Model |
  |---|---|---|---|
  | `TESTB-3`, `TESTB-4`, `TESTB-5`: implement | 3 | 3 | `sonnet` |
  | Their reviews, started by themselves | 3 | 3 | `sonnet` |
  | Probe and allowlist smoke tests (only if Claude Code changed after 2.1.302) | 4 | 3 | `haiku` |
  | `--probe-limit` (only while limited: refused at no cost) | 1 | 1 | `sonnet` |

  In all: **6 `sonnet` sessions with 6 messages**, each reminder adding 1, and each request for changes by Quality 2 sessions and 2 messages (Q16 A).
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
| **Push again** | Q8 A: moved to lot 7 (10), with lot 3's design |
| Criteria numbered from 0 | Q13 with its fallback: step B tells agents to write numbers from 1; the tool's index from 1 can come with lot 7's daemon update |
| A request contradicting a criterion | Q14; step B |

Also from lot 3 and spec 10, outside that list: agents under a separate system user (Q11 A: lot 7), the usage-limit signal capture (Q12 A: step L if the limit is reached, else lot 7), GitHub's conditional requests (lot 3 step J's option C; Q15c: left out), the heartbeat's resource summary (05 section 3.3; Q15b: left out), the flaky test of lot 3 step N (step B). **Pause now** and the pause at a window's end (Q7 B) stay in 07 for later, in no lot yet.

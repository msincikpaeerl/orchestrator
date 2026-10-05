# Lot 3 — Implementation plan

> Status: in progress (step A)
> Scope: "Lot 3 — Full ticket lifecycle" in [10 — Delivery Plan](../specs/10-delivery-plan.md).
> **Lot 3 is done when** a ticket goes from `todo` to `done` with a reviewed, merged pull request, without the owner touching Git.

Every session follows the [working rules](working-rules.md). Branches: `lot3/<step letter>-<short-name>`. Steps are done one after the other, in the order below. No session acts on the real GitHub (rule 9) or starts a real Claude Code session (rule 10): the server is tested against the local fake GitHub, the daemon with real tmux and the fake `claude`. The real GitHub is used only by the owner, in steps E and N; the real Claude Code only in step N. Lot 3 is released as version 0.4.0.

## Decisions taken for this lot (2026-10-05)

Confirmed by the owner in step A and written into the specs (01, 02, 03, 04, 05, 06, 07, 09 and 10). Question numbers are those of step A's list.

**Push** (05 sections 4.9, 4.11 and 7; 04 section 4):

- The daemon pushes at `ticket_submit`, before forwarding the call, when the worktree is clean and the branch has commits ahead; the push result goes with the worktree facts and the server checks it with the rest (Q1).
- It also pushes at every run end that leaves commits not on GitHub: failure, give up, timeout, **Stop run**. That push is **best effort**: it never changes the run's outcome, and when it fails the ticket still says "not on GitHub yet" (Q1 b).
- It pushes **only the ticket's branch, by an explicit refspec** (`refs/heads/<ticket branch>:refs/heads/<ticket branch>`), never a tag or another branch; a test proves that a branch or a tag an agent created is not pushed (Q1 a).
- **A review run never pushes.** The daemon reports whether the branch head moved during a review; if it did, the review fails with a clear reason (Q1 c).
- Never a force push. Agents bring the base branch in with `git merge origin/<base>` (added to the builders' allowlist; the daemon fetches before each run). At preparation, when the GitHub branch contains the local one (for example after GitHub's **Update branch**), the daemon fast-forwards the local branch; a diverged branch fails the push with a clear reason and a "Needs you" item. 04 section 4's rebase is replaced (Q2).
- Once a ticket's branch is on GitHub, Run now no longer needs the machine holding its commits (07 section 3): the next run takes the branch from GitHub on any machine.

**Pull request** (04 section 3.1, 06 section 4.2):

- The **server** opens the pull request, through GitHub's API, **only when a submission passes the server's checks**, and updates its description at each later accepted submission; a push at a run's end never opens one (Q3, corrected by the owner). A normal pull request, not a draft. Title `<number>: <title>`; description from the DoD report (summary, criteria checklist, tests, docs, ADRs) and a link to the ticket page.
- **Workflow changes**: when a submission changes anything under `.github/workflows/`, the pull request description, the review's first message and "Needs you" say so; Help explains why (an agent could weaken the checks that judge its own work, and a changed workflow runs on GitHub before anyone reads it) (owner's addition).
- Mechanical DoD checks (Q5): every criterion `met`; for each ticket type, where 04 section 3.3 says "required", the report lists paths or gives a justification; every listed path is changed on the branch (the daemon sends the files changed against the base with the facts); the push succeeded; CI passed.

**GitHub token** (02 section 3, `docs/user/github-token.md`, Q4): no new permission. The page says what each permission does from 0.4.0. The token check gains read probes where one exists (Actions, Pull requests, Commit statuses). A write permission found missing at first use gives a "Needs you" item naming it. Help links to GitHub's page on Actions minutes instead of a number. Reviews are posted as comment reviews, because GitHub refuses approval and request-changes on your own pull request, and every pull request is the owner's.

**CI** (04 section 3.1, 05 section 4.9, 06 section 4.1):

- While CI runs, the session stays open; the run shows "waiting for CI", with no working time and no idle timeout, and still counts against the account's maximum concurrent runs (Q6).
- The CI result is every GitHub Actions run for the pull request's head commit, plus that commit's statuses: passed when all are completed and successful (skipped or neutral count as passed); failed when all are completed and one failed, was cancelled or timed out (Q8).
- No run within **Wait for CI to start**: the check reads "No CI found", the submission passes, and Quality is told (Q9).
- A failure is sent with `run.input` from the template `agents/templates/ci-failed.md`: each failed job and step, with the end of its log cut to the setting **Longest CI log excerpt** (Q10: a setting, not a new constant). `ci_status` returns the same for the run's pull request. One failure more than **Most CI failures per run** (default 2) ends the run with `ci_failed`, counted as an attempt.
- **CI wait at submission** reached: the run fails with `ci_timeout`, not counted; the ticket returns to `todo` with its branch and pull request; "Needs you" shows "CI did not finish" with **Check CI again**, which starts no session (one GitHub read): when CI has passed since, the stored submission is accepted and the ticket goes to `in_review` (Q7). The setting's description is reworded.
- Polling: **GitHub check interval** (60 s), only for tickets waiting on GitHub (Q11).

**Quality** (03 sections 2.5 and 3, 04 sections 2 and 3.2, 06 section 4.5, 07 section 3):

- Before the scheduler (lot 4) the owner starts reviews: an `in_review` ticket shows **Start review** (Run now with the `quality` profile, purpose `review`) and **Skip review** (`in_review` → `awaiting_merge`, with a `status_change` comment saying the owner skipped it). "Needs you" lists "Ready for review" with the pull request link and the CI result. Help says plainly that a review costs one session and skipping costs none. **Run now** on a `todo` ticket whose last review asked for changes starts a `fix_review` run (Q12). Lot 4 decides again when reviews start by themselves.
- The `quality` profile: Sonnet; the builders' allowlist without `Edit`, `Write`, `git add`/`commit`/`rm`/`mv`/`restore`, `mkdir`, `mv`, `cp` and `rm`. Its instructions say that CI already ran, so it does not run the test suite again unless the diff or the CI result gives a reason (Q13). Its first message holds the ticket, the DoD report, the CI result, earlier review points, workflow changes and how to see the diff.
- Quality may ask with `ticket_ask`: `in_review` → `waiting_human`, and the answer returns the ticket to `in_review` in the same run. A review run that fails or gives up never counts against the ticket's attempts; the ticket stays `in_review` and "Needs you" shows "Review did not finish" with **Start review** (Q14).
- `review_approve` and `review_request_changes` are each posted on GitHub as one comment review, the points in its body with `file:line` when given. A failed post leaves the Orchestrator's decision in place, with an event and a note on the ticket page (Q15).
- **Most review rounds per ticket** (default 2): one request for changes more stops the ticket and "Needs you" asks the owner, as for failed attempts (Q16).
- `fix_review`: the ticket's assignee, the same branch and pull request, the latest review's points in the first message, then CI, then `in_review`. Quality asking for changes is never a failed attempt; a `fix_review` run that fails by itself (gives up, times out, `ci_failed`) counts like an implement run (Q17).
- The owner's **Request changes** (Q18, the decision spec 10 asked for): on `in_review` while no review run is active (not offered while one runs), on `awaiting_merge`, and on `in_review` tickets without a pull request (left by 0.3.0). Its next run is `fix_review`, with the owner's comment as the point. On those 0.3.0 tickets, **Mark as done manually** stays too.

**Merge and done** (04 sections 2 and 4, 02 section 4):

- A pull request merged into the default branch moves the ticket to `done` from any state with an open pull request, stopping an active run, with a `system` comment (saying so when the review had not finished); the tickets it blocked are unblocked (Q19).
- "Needs you" lists pull requests to merge: link, review summary (or "review skipped"), CI result, conflicts and workflow-change flags, ordered by when the wait began.
- A pull request closed without merging on GitHub: the ticket is unchanged; "Needs you" shows "Pull request closed without merging" with **Reopen pull request** and **Cancel ticket**. Cancelling a ticket closes its pull request; reopening the ticket leaves it closed until the next accepted submission reopens it (Q20).
- Conflicts with the base branch while `awaiting_merge`: "Needs you" shows "Conflicts with <base>", and **Request changes** comes with a filled-in comment asking to merge the base branch and resolve them (Q21).
- Cleaning up a ticket's branches and worktree after a merge or a cancellation: **open**, the owner chooses before step J (options in step J).

**Failures and retries** (04 section 5, 01 section 3.7):

- **Failed attempts before asking you** reached: the ticket stays `todo`, marked "stopped after N failed attempts"; **Run now** refuses; "Needs you" ("Tickets stopped after repeated failures") offers **Try again** (resets the count, with a comment), **Cancel** and **Mark as done manually** (Q22). The same stop applies to **Most review rounds per ticket**.
- Counted: `ci_failed`, and the failures counted in lot 2. Not counted: `ci_timeout`, `push_failed` (GitHub refused the push or could not be reached; a "Needs you" GitHub item), `review_branch_moved` and every other failure of a review run (Q23).
- **For lot 4** (written into 10, lot 4): a failure that is not counted (`ci_timeout`, `push_failed`, a review that did not finish) leaves a blocking "Needs you" item, so the scheduler never retries it in a loop.

**Protocol and daemon updates** (05 section 3.3, 09 section 6):

- `PROTOCOL_VERSION` 2 (Q24): `git.credential_request` gains `push`; the `ticket_submit` facts gain the push result and the changed files; `review_approve` and `review_request_changes` are decisions; an accepted submission answers `pending_ci` and the daemon waits for CI; the server ends a run waiting for CI with `run.stop` reason `completed`; `run.start` carries the `review` and `fix_review` purposes; `run.state` gains `waiting_ci`, the end reasons `ci_failed`, `ci_timeout`, `review_branch_moved` and the pushed head; `hello` gains the daemon's build.
- A protocol 1 daemon (0.3.0) is accepted as the previous version but is **unusable**: "Daemon 0.3.0 is older than this Orchestrator (0.4.0): update it", with the update commands, as "Update the daemon on X" in "Needs you".
- **Daemon build** (Q25, owner's addition): the daemon sends a **build identifier** in `hello`, a hash of its bundled sources computed when the package is built; the server compares it with the build of the bundle it serves. A different build with the same protocol gives a warning on the machine page and a non-blocking "Needs you" item, "A newer daemon is available for X". `orchestrator-daemon --version`, `status` and the machine page show it.
- Help > Machines gains "Update the daemon", with the commands that worked on 2026-10-03: `npm uninstall -g @orchestrator/daemon`, `npm install -g --prefer-online <server URL>/downloads/orchestrator-daemon-<version>.tgz`, `orchestrator-daemon install-service`.

**Local fake GitHub** (Q26, `docs/dev/testing.md`): one fake joining REST and Git. Pushes over HTTP with token checks land in the repositories the REST API reads. It also covers:

- pull requests (create, read, list, update, close, reopen, merged, mergeable);
- reviews, refusing approval and request-changes on your own pull request;
- Actions runs by commit, with jobs, steps and logs behind a redirect, and commit statuses;
- test controls for CI (queued, running, success, failure with a log, never starts) and for the owner's actions (merge, close, **Update branch**, conflict);
- refusals: 401, and 403 naming the missing permission.

The end-to-end server uses it.

**Carried from lot 2**:

- Every hook refusal ends with one suffix in line with the common rules: "Do not ask the owner to allow it. If your ticket cannot be done without it, say so in plain words with `ticket_ask` or `ticket_give_up`." 03 section 3.2 records the hook's reasons as the one agent-facing text kept in the daemon, since they must work without the server (Q29).
- The common rules say to ignore tips Claude Code shows about its own commands (such as `/ultrareview`); the documentation is checked again at each Claude Code validation (Q30).
- The probe gains a check 6: `PASS` when the session's transcript records the `dontAsk` permission mode; resumed sessions stay covered by the tests (Q31).
- The `Stop` hook error at a run's end: logging only (Q32). The daemon logs, with the run id, when it kills a session and every hook connection still open at that moment; the cause is fixed once the log shows it.
- The specs name settings as the Settings screen does, with their keys (Q33).

**New settings** (04 section 8, used from 0.4.0):

| Setting | Key | Default | Range | Per project |
|---|---|---|---|---|
| Wait for CI to start | `ciStartWaitMinutes` | 5 minutes | 1 to 60 minutes | Yes |
| Most CI failures per run | `maxCiFailuresPerRun` | 2 | 1 to 10 | Yes |
| Longest CI log excerpt | `ciLogExcerptMaxLength` | 4,000 characters | 500 to 20,000 characters | No |
| GitHub check interval | `githubPollSeconds` | 60 seconds | 15 to 600 seconds | No |
| Most review rounds per ticket | `maxReviewRounds` | 2 | 1 to 10 | Yes |

`maxFailedAttempts` and `ciWaitTimeoutMinutes` are already marked "used from 0.4.0". A CI result message and `ci_status` hold at most one excerpt per failed job, and their whole text stays within `MCP_OUTPUT_MAX_CHARACTERS` and the `run.input` ceiling: excerpts are cut further, the longest first, with a marker.

**What a ticket costs** (Sonnet, the model of every default profile; each message reloads the session's context):

| Event | Sessions | Messages |
|---|---|---|
| Implement run | 1 | 1 |
| Each CI failure sent back | 0 (same session) | +1 |
| Each reminder | 0 | +1 |
| Review run (or **Skip review**: none) | 1 | 1 |
| Each round of changes (`fix_review`, then review again) | +2 | +2 |

### When the owner's installed daemon stops working

From **step B** on, `main` speaks protocol 2. A server built from `main` after step B is merged accepts the owner's installed 0.3.0 daemon but marks the machine unusable ("Update the daemon on X"), so **Run now** refuses on it. An Orchestrator still running 0.3.0 (the release image) is not affected. When the owner runs a server built from `main` with a real machine (step N at the latest), they update the daemon from that server with Help > Machines > "Update the daemon":

```sh
npm uninstall -g @orchestrator/daemon
npm install -g --prefer-online <server URL>/downloads/orchestrator-daemon-0.4.0.tgz
orchestrator-daemon install-service
```

then check the machine page: online, usable, and the build the same as the server's. Step E's check needs no daemon.

### Lessons of lot 2, applied in every step

- **Asynchronous causes**: a test waits, with a deadline, for the observable effect (a file, a database row, a stream message, a GitHub state in the fake), never for a delay or for a log line written before the effect (lot 2 step M, scenario C).
- **The owner's processes and units**: a test's daemons, tmux servers, sessions and systemd units never look like the owner's. Test homes are under `/tmp/od-test-*`, units are named `od-test-<hash>-…`, every spawned process is in its own process group and stopped until none is left, and each test file ends with `stopHomeProcesses` (lot 2 steps K, M and N).
- **CI duration**: a CI test shard that takes more than 8 minutes gets a new shard in the same change (ADR 0032).
- **Rules 9 and 10**: only the owner touches the real GitHub and the real Claude Code. Every script that can do either refuses to run in CI or without a terminal and asks for a typed `yes` (`tools/smoke/lib/real-claude-guard.sh`, extended to GitHub in step E).

## Steps

### [ ] A. Plan and spec decisions

- This plan; the decisions above written into specs 01, 02, 03, 04, 05, 06, 07, 09 and 10; the settings named as on the screen (04 section 8, 05 section 5, 07 section 8); CLAUDE.md's "Current state".

**Done when** the owner has approved this plan and the spec changes, and chosen the clean-up option of step J.

### [ ] B. Protocol 2, daemon build and updates

- `packages/protocol`: every lot 3 message and tool as Zod schemas (as lot 2 step B):
  - `git.credential_request` `push`;
  - `mcp.call` facts for `ticket_submit`: push result, changed files;
  - `ticket_submit` result `pending_ci` or the failed checks;
  - `review_approve`, `review_request_changes`, `ci_status`;
  - `run.start` purposes `review` and `fix_review`;
  - `run.state` `waiting_ci`, end reasons `ci_failed`, `ci_timeout`, `review_branch_moved`, pushed head and "head moved" for a review;
  - `run.stop` reason `completed`;
  - `hello` `daemonBuild`.

  `PROTOCOL_VERSION` 2, returned by `/version`.
- Daemon build identifier: computed from the bundled sources when the package is built, embedded in the bundle, shown by `--version` and `status`. The server reads the build of the bundle it serves.
- Server: a protocol 1 daemon is accepted but unusable, with the update commands; a different build with protocol 2 is a warning and a non-blocking "Needs you" item. The machine page shows the build.
- The daemon speaks protocol 2: the decision tools of the relay include the review tools. Its behaviour is unchanged until the steps that use the new messages.
- `docs/user/machines.md` "Update the daemon"; `needs-you.md` rows; CHANGELOG.

**Done when**:

- unit tests accept a valid example of every new message and tool and reject invalid ones;
- `/version` reports protocol 2;
- integration tests show a protocol 1 `hello` online but unusable with the update commands, a different build giving the warning item, and the same build giving none;
- a test installs the served package and `orchestrator-daemon --version` prints the build the server reports.

### [ ] C. Local fake GitHub

- `apps/server/test/fake-github.ts` grows into the fake of the decisions above, and the Git HTTP test server of `@orchestrator/daemon/testing` serves the fake's repositories with token checks (`git http-backend` behind it), so a push is seen by the REST API.
- Test controls for CI and for the owner's actions on GitHub, also reachable from the end-to-end server.
- `docs/dev/testing.md`: what the fake covers and how to script it.

**Done when** tests of the fake itself cover:

- a push with the token and one without (refused);
- a pull request opened, read, updated, closed, reopened and merged;
- a review on your own pull request refused for approval and request-changes and accepted as a comment;
- CI runs scripted through queued, running, success and failure with a log read through the redirect;
- commit statuses;
- a conflict and **Update branch**;
- 401, and 403 naming a permission.

### [ ] D. Push by the daemon

- `git.credential` for `push`: the server gives it only for the run's own repository while the run is active or ending.
- The push with the per-command credential helper and an explicit refspec of the ticket branch, never `--force`, never tags. It happens:
  - at `ticket_submit`, with the result in the facts;
  - at every run end with commits not on GitHub, best effort;
  - never for a review run, which reports whether the head moved.
- Preparation: the local branch is fast-forwarded to GitHub's when GitHub's contains it; a diverged branch is reported.
- `git merge` added to the builders' allowlist; the common rules say how to bring the base branch in.
- Server: the branch head on GitHub stored per ticket; the ticket page shows "on GitHub" or "on machine X, not on GitHub yet"; Run now's machine rule (07 section 3) applies only to commits not on GitHub.

**Done when** daemon tests (fake `claude`, the fake GitHub's Git server) show:

- the push at submission and at a failed run's end;
- a branch and a tag the agent created not pushed;
- no token in any Git configuration, remote URL or file after a push;
- a failed end push leaving the outcome unchanged;
- a review run never pushing and reporting a moved head;
- the fast-forward after **Update branch**, and a diverged branch reported;
- Run now taking a pushed branch on another machine.

### [ ] E. GitHub layer and the owner's check of the real GitHub

- `apps/server/src/github/`: pull requests (open, update, close, reopen, read merged and mergeable), Actions runs, jobs and log excerpts, commit statuses, comment reviews, each with its refusals turned into "Needs you" GitHub items naming the permission. The token check gains the read probes of Actions, Pull requests and Commit statuses.
- `tools/smoke/github-smoke.sh`, for the owner only (rule 9), with no Claude quota. It uses this layer and the daemon's push code on a repository the owner names, after a typed `yes`. It refuses:
  - the Orchestrator's own repository (read from this checkout's `origin`);
  - CI, or a run without a terminal;
  - a repository that does not exist.

  **The token** is read from the terminal without echo (`read -s`), held only in the script's process memory, passed to its Node.js helper through a pipe on standard input, never written to disk, never in arguments, the environment of child processes, shell history or output, and masked in any message GitHub sends back. Its steps, each printing `PASS` or `FAIL`:
  1. push a branch `orchestrator-smoke-<time>` with one commit through the per-command credential helper; no credential left in the scratch clone's configuration;
  2. open a pull request; read it back;
  3. wait for CI and read its result (Actions runs and commit statuses);
  4. push a commit with a broken documentation link; wait for the failure; read the failed job's log excerpt;
  5. post a comment review; check that a request-changes review on your own pull request is refused as expected;
  6. read the mergeable flag;
  7. ask the owner to merge it on GitHub (the script waits), then detect the merge;
  8. open a second pull request from a second branch; ask the owner to close it without merging; detect that.

  At the end it deletes its branches on GitHub and its scratch clone (the merged commit stays on the default branch). If it stops early, it says what it left (branches, pull requests) and how to remove them. Checked in CI with `bash -n` and a dry run against the fake GitHub.
- The guard of `tools/smoke/lib/` also covers scripts that act on the real GitHub.

**Done when** the fake GitHub tests cover every function and refusal, the script passes its dry run, and **the owner has run it once on their test repository with every step `PASS`**. The results are recorded here. A step that fails is settled with the owner before step F.

**The owner's run**: a WSL terminal in the repository. A test repository of their own account with the skeleton (for example the `test0.3.0` project's), its default branch protected or not. The token in hand. About 5 minutes, 4 CI runs (the skeleton's `docs-links` and `ci` jobs, about 1 minute each). Command: `tools/smoke/github-smoke.sh --repository <owner>/<name>`.

### [ ] F. Full submission and the pull request

- `ticket_submit` (04 section 3.1, without CI yet):
  - the push result;
  - the criteria;
  - the per-type form checks;
  - listed paths changed on the branch.
- The pull request opened or updated by the server on an accepted submission, its description from the template `agents/templates/pull-request.md`; workflow changes flagged in it and on the ticket.
- Until step G, an accepted submission ends the run and the ticket goes to `in_review` with the pull request link (lot 2's meaning plus the pull request: the owner checks it).
- Ticket page: pull request link, DoD report with each check's result. `push_failed` with its "Needs you" item. The template `implement.md` and the common rules updated for the full submission.
- `docs/user/`: Tickets ("Submission and the pull request"), Needs you, `github-token.md` rewritten for 0.4.0; CHANGELOG.

**Done when** integration tests with a scripted daemon and the fake GitHub cover each failed check (criteria, type rules, a listed path not changed, the push refused), the pull request opened then updated, the workflow flag, and `push_failed`; Playwright on both viewports shows a submitted ticket with its pull request link and checks.

### [ ] G. CI

- The polling loop (**GitHub check interval**), restored at server start.
- CI as decided:
  - `pending_ci`;
  - the daemon's `waiting_ci` (no nudge, no working time, no idle timeout);
  - **Wait for CI to start** ("No CI found");
  - failure through `run.input` (template `ci-failed.md`, **Longest CI log excerpt**);
  - **Most CI failures per run** (`ci_failed`, counted);
  - success: `run.stop` `completed` and `in_review`;
  - **CI wait at submission** (`ci_timeout`, not counted, "CI did not finish" with **Check CI again**).
- `ci_status` for all roles.
- Ticket and run pages: "waiting for CI", the CI result per run and job. The settings and their texts; Help; CHANGELOG.

**Done when** daemon and server tests show:

- CI passing;
- CI failing once then passing in the same session;
- one failure too many;
- no CI found;
- the timeout, then **Check CI again** accepting the stored submission without a session;
- the idle timeout and working time not counting while waiting;
- `ci_status` cut to the setting.

Playwright: a ticket waiting for CI, then in review with its CI result.

### [ ] H. Quality and review runs

- `agents/quality.md` (03 section 2.5, with the instruction on not running the tests again), the templates `review.md`, `fix-review.md` and the review's place in the common rules; the allowlist smoke test covers `quality` (different rules from `architect`).
- **Start review** (Run now with purpose `review`, the `quality` profile, any machine, the branch from GitHub) and **Skip review**; "Ready for review" in "Needs you".
- `review_approve` (`awaiting_merge`) and `review_request_changes` (points as `review` comments, `todo`), each posted on GitHub as a comment review; the reviewer is never the profile that implemented it.
- Quality's questions (`in_review` → `waiting_human` → `in_review`).
- Review failures not counted ("Review did not finish"); a moved head fails the review.
- Help: Quality, what a review costs, **Skip review**, workflow changes; CHANGELOG.

**Done when** integration and daemon tests cover:

- approval;
- request for changes (comments, GitHub review, `todo`);
- a GitHub post refused (decision kept, note shown);
- a question answered;
- a review run giving up;
- a moved head;
- **Skip review**;
- a builder profile refused the review tools.

Playwright: **Start review**, **Skip review**, the review summary on the ticket page.

### [ ] I. Changes after a review

- `fix_review` runs: **Run now** picks the purpose, first message with the latest points, same branch and pull request, CI, then `in_review`.
- **Most review rounds per ticket**.
- The owner's **Request changes** on `in_review` (no review run active), on `awaiting_merge` and on 0.3.0 tickets without a pull request (with **Mark as done manually**), each leading to `fix_review`.
- Attempts: Quality's request never counts; a failing `fix_review` run counts.

**Done when** tests cover:

- a full round (changes requested, fixed, reviewed again, approved);
- the rounds limit stopping the ticket;
- **Request changes** offered and refused in each state (refused while a review run is active);
- a 0.3.0 `in_review` ticket handled;
- a failing `fix_review` counted.

Playwright: **Request changes** from `awaiting_merge` leading to a `fix_review` run.

### [ ] J. Merge detection, done and cancelled pull requests

- Polling of open pull requests:
  - merged into the default branch → `done` from any state with an open pull request (active run stopped, comment), dependents unblocked;
  - closed without merging → "Needs you" with **Reopen pull request** and **Cancel ticket**;
  - conflicts while `awaiting_merge` → "Needs you" with the filled-in **Request changes**.
- **Cancel** closes the pull request; the next accepted submission of a reopened ticket reopens it.
- "Needs you" pull requests to merge (link, review summary or "review skipped", CI, conflicts and workflow flags).
- Branch and worktree clean-up, as the owner chooses before this step. Options (the worktree itself is already removed at each run's end, except for waiting and paused runs):
  - A (recommended): after a **merge**, the server deletes the ticket's branch on GitHub, only if no other open pull request uses it (Contents write), and the daemon deletes its local ticket branch at its next fetch of that repository when the branch is gone from GitHub and every one of its commits is in the base branch. After a **cancellation**, nothing is deleted (04 section 2: "closed but kept"), so **Reopen** finds the work.
  - B: nothing is deleted by the Orchestrator; the owner turns on GitHub's "Automatically delete head branches" if they want; local branches stay until the bare clone is pruned.
  - C: as A, and a cancellation also deletes the GitHub branch after a delay (a setting); **Reopen** then starts from the base branch.
- Help: merging, closed pull requests, conflicts; CHANGELOG.

**Done when** tests with the fake GitHub cover: a merge to `done` (dependents unblocked), a merge during `in_review` with a run active, a pull request closed then reopened, cancel closing it, conflicts, and the clean-up chosen. Playwright: "Needs you" lists a pull request to merge, which becomes `done` after the fake merge without reload.

### [ ] K. Failures and retries

- **Failed attempts before asking you** and **Most review rounds per ticket** stop a ticket: marked on the board and ticket page, **Run now** refuses, "Needs you" offers **Try again**, **Cancel** and **Mark as done manually**.
- The counted and not counted failures of lot 3 (`ci_failed`, `ci_timeout`, `push_failed`, review failures), each with its `system` comment.
- 04 section 5 rewritten from the code; lot 4's rule on blocking items already in 10.
- Help: "When a ticket keeps failing"; CHANGELOG.

**Done when** tests cover a ticket stopped after its failed attempts then tried again (count reset, comment), each failure reason counted or not as decided, and Run now's refusal naming the setting and its value. Playwright: **Try again** from "Needs you".

### [ ] L. Carried from lot 2

- The one refusal suffix of every `PreToolUse` refusal (03 section 3.2 and 05 section 4.6), with the tests of each reason.
- The common rules' line on Claude Code's tips; profile versions go up.
- The probe's check 6 (permission mode `dontAsk` in the transcript), with its dry run, and the fixtures of 2.1.287 read for it.
- Logging of a session kill and of the hook connections open at that moment, with the run id (05 section 4.11).

**Done when** the refusal tests read the new suffix, the probe's dry run prints check 6 `PASS` with the fake `claude` writing `dontAsk` and `FAIL` with another mode, and a daemon test finds both log lines when a hook is still running at a run's end.

### [ ] M. End-to-end lot 3 test

- `apps/server/test/acceptance.test.ts` gains, with the real server, the real daemon, tmux, the fake `claude` and the fake GitHub:
  - scenario D: `todo` → implement → push → pull request → CI failing once → fixed → CI passing → **Start review** → approved → merge on the fake → `done`;
  - scenario E: **Skip review** → **Request changes** from `awaiting_merge` → `fix_review` → `done`;
  - scenario F: CI never finishing → `ci_timeout` → **Check CI again** after CI passed → `in_review`.
- Every process and folder of its test homes cleaned.

**Done when** the three scenarios pass in `pnpm test` (and in CI within the shards' 8 minutes).

### [ ] N. Lot 3 check by the owner

- Version 0.4.0 prepared (rule 14).
- The owner:
  1. updates the daemon with Help > Machines > "Update the daemon" from the server of this branch, and checks the machine page (online, usable, same build);
  2. runs `claude-code-probe.sh` again if Claude Code changed since 2.1.287 (check 6 included), and `allowlist-smoke.sh` (`architect`, then `quality`, whose rules differ);
  3. follows `docs/user/` alone with the two tickets below, in a ready project with the skeleton's CI (the `test0.3.0` project or a new one).
- **Ticket 1, CI failing once** (type **Documentation**, assignee **Web Developer**):
  - title `Add a FAQ link to README.md`;
  - description: `This ticket checks the Orchestrator's CI feedback. Add the line "See the [FAQ](docs/user/faq.md)." at the end of README.md and commit it. Do not create docs/user/faq.md and do not run the documentation link check yourself: CI must fail once, on purpose. When the CI result reports the broken link, create docs/user/faq.md containing the line "No questions yet.", commit it and submit again. Do nothing else.`;
  - criteria, one per box: `README.md ends with a link to docs/user/faq.md`, then `CI passes on the pull request`;
  - expected: submission, pull request, CI fails, the agent gets the message, creates the file, submits, CI passes, `in_review`. The owner uses **Skip review**, merges on GitHub, and sees `done` without reloading.
- **Ticket 2, review and changes** (type **Documentation**, assignee **Web Developer**):
  - title `Add one line to README.md`;
  - description: `Add the line "Reviewed by the Orchestrator." at the end of README.md and commit it. Do nothing else.`;
  - criterion: `README.md ends with the line "Reviewed by the Orchestrator."`;
  - expected: CI passes, **Start review**, Quality approves (or asks for changes: then one more `fix_review` round), `awaiting_merge`. The owner then uses **Request changes** with the comment `Also add this line after it: Changed on request.`; a `fix_review` run, CI passes. The owner uses **Skip review**, merges on GitHub, sees `done`.
- **Quota** (estimates; each message makes the agent take several steps):

  | Item | Sessions | Messages | Model |
  |---|---|---|---|
  | Ticket 1, implement with one CI failure | 1 | 2 (the ticket, the CI result) | `sonnet` |
  | Ticket 1, **Skip review** | 0 | 0 | — |
  | Ticket 2, implement | 1 | 1 | `sonnet` |
  | Ticket 2, review | 1 | 1 | `sonnet` |
  | Ticket 2, `fix_review` after Request changes | 1 | 1 | `sonnet` |
  | Ticket 2, **Skip review** | 0 | 0 | — |
  | Allowlist smoke test (`architect`, `quality`) | 2 | 2 | `haiku` |
  | Probe (only if Claude Code changed after 2.1.287) | 2 (the control one sends nothing) | 1 | `haiku` |

  In all: **4 `sonnet` sessions with 5 messages**, and 2 `haiku` sessions with 2 messages (4 sessions and 3 messages if the probe runs). Each reminder adds 1 message. If Quality asks for changes on ticket 2, that adds 2 `sonnet` sessions and 2 messages.
- **A pass**: both tickets `done` with a merged pull request; ticket 1's run log shows the CI failure message and the second submission; ticket 2 shows Quality's review on the ticket page and as a comment on GitHub, then the `fix_review` run with the owner's comment; no Git command typed by the owner; nothing on GitHub but the two merged pull requests and their branches (handled as chosen in step J); the probe and the smoke test print `PASS` (or `INFO` for the probe's check 5).
- If the owner's checks pass on a newer Claude Code, `CLAUDE_CODE_VALIDATED_VERSION` is raised. Gaps found are fixed, each with its test; results recorded here.

**Done when** the owner has run the scenario from the user documentation alone and confirmed it, and lot 3 is closed as version 0.4.0.

## Carried to lot 4

- A failure that is not counted (`ci_timeout`, `push_failed`, a review that did not finish) leaves a blocking "Needs you" item, so the scheduler never retries it in a loop (written into 10, lot 4).
- When reviews start by themselves (lot 3: **Start review** by the owner).
- Whether waiting for CI should still count against the account's maximum concurrent runs once runs start by themselves.

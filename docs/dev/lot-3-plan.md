# Lot 3 — Implementation plan

> Status: in progress (steps A, B, C, D1 and D2 done; step D split into D1, D2 and D3)
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
- Clean-up after a merge (option A, corrected by the owner): the server deletes the ticket's branch on GitHub, unless another open pull request uses it, and accepts a branch GitHub already deleted. The daemon deletes its local ticket branch when the server says the ticket's pull request is merged and the local head is the head that was merged (nothing unpushed); "every commit in the base branch" is never true after a squash merge. After a cancellation nothing is deleted, so **Reopen** finds the work.

**Failures and retries** (04 section 5, 01 section 3.7):

- **Failed attempts before asking you** reached: the ticket stays `todo`, marked "stopped after N failed attempts"; **Run now** refuses; "Needs you" ("Tickets stopped after repeated failures") offers **Try again** (resets the count, with a comment), **Cancel** and **Mark as done manually** (Q22). The same stop applies to **Most review rounds per ticket**.
- Counted: `ci_failed`, and the failures counted in lot 2. Not counted: `ci_timeout`, `push_failed` (GitHub refused the push or could not be reached; a "Needs you" GitHub item), `review_branch_moved` and every other failure of a review run (Q23).
- **For lot 4** (written into 10, lot 4): a failure that is not counted (`ci_timeout`, `push_failed`, a review that did not finish) leaves a blocking "Needs you" item, so the scheduler never retries it in a loop.

**Protocol and daemon updates** (05 section 3.3, 09 section 6):

- `PROTOCOL_VERSION` 2 (Q24): `git.credential_request` gains `push`; the `ticket_submit` facts gain the push result and the changed files; `review_approve` and `review_request_changes` are decisions; an accepted submission answers `pending_ci` and the daemon waits for CI; the server ends a run waiting for CI with `run.stop` reason `completed`; `run.start` carries the `review` and `fix_review` purposes; `run.state` gains `waiting_ci`, the end reasons `ci_failed`, `ci_timeout`, `review_branch_moved` and the pushed head; `hello` gains the daemon's build.
- A protocol 1 daemon (0.3.0) is accepted as the previous version but is **unusable**: "Daemon 0.3.0 is older than this Orchestrator (0.4.0): update it", with the update commands, as "Update the daemon on X" in "Needs you".
- **Daemon build** (Q25, owner's addition): the daemon sends a **build identifier** in `hello`, a hash of its bundled sources computed when the package is built; the server compares it with the build of the bundle it serves. A different build with the same protocol gives a warning on the machine page and a non-blocking "Needs you" item, "The daemon on X is not the one this Orchestrator provides": a different build is not always a newer one (owner's correction). `orchestrator-daemon --version`, `status` and the machine page show it.
- Help > Machines gains "Update the daemon", with the commands that worked on 2026-10-03: `systemctl --user stop orchestrator-daemon`, `npm uninstall -g orchestrator-daemon`, `npm install -g --prefer-online <server URL>/downloads/orchestrator-daemon-<version>.tgz`, `orchestrator-daemon install-service`, then `orchestrator-daemon doctor`. The installed package is named `orchestrator-daemon` (`apps/daemon/scripts/pack.ts`), not `@orchestrator/daemon` (the workspace's name).

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
systemctl --user stop orchestrator-daemon
npm uninstall -g orchestrator-daemon
npm install -g --prefer-online <server URL>/downloads/orchestrator-daemon-0.4.0.tgz
orchestrator-daemon install-service
orchestrator-daemon doctor
```

then check the machine page: online, usable, and the build the same as the server's. Step E's check needs no daemon.

### Lessons of lot 2, applied in every step

- **Asynchronous causes**: a test waits, with a deadline, for the observable effect (a file, a database row, a stream message, a GitHub state in the fake), never for a delay or for a log line written before the effect (lot 2 step M, scenario C).
- **The owner's processes and units**: a test's daemons, tmux servers, sessions and systemd units never look like the owner's. Test homes are under `/tmp/od-test-*`, units are named `od-test-<hash>-…`, every spawned process is in its own process group and stopped until none is left, and each test file ends with `stopHomeProcesses` (lot 2 steps K, M and N).
- **CI duration**: a CI test shard that takes more than 8 minutes gets a new shard in the same change (ADR 0032).
- **Step size**: a session that finds its step too large for one session says so before writing any code and proposes a split, which the owner approves (working rule 15).
- **Rules 9 and 10**: only the owner touches the real GitHub and the real Claude Code. Every script that can do either refuses to run in CI or without a terminal and asks for a typed `yes` (`tools/smoke/lib/real-claude-guard.sh`, extended to GitHub in step E).

## Steps

### [x] A. Plan and spec decisions

- This plan; the decisions above written into specs 01, 02, 03, 04, 05, 06, 07, 09 and 10; the settings named as on the screen (04 section 8, 05 section 5, 07 section 8); CLAUDE.md's "Current state".

**Done when** the owner has approved this plan and the spec changes.

*Done 2026-10-05.* Approved by the owner with six corrections: the daemon's package name and the update commands that worked (with a test in step B); the smoke script repairs the link and waits for CI before the merge; ticket 1 of step N keeps one criterion the agent can meet, and Help > Tickets says what a criterion is; clean-up option A without the base-branch comparison; working rule 15 on step size, and step G split into G1 and G2; the "Needs you" item for a different daemon build named so it stays true both ways.

### [x] B. Protocol 2, daemon build and updates

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
- Server: a protocol 1 daemon is accepted but unusable, with the update commands; a different build with protocol 2 is a warning and a non-blocking "Needs you" item, "The daemon on X is not the one this Orchestrator provides". The machine page shows the build.
- The daemon speaks protocol 2: the decision tools of the relay include the review tools. Its behaviour is unchanged until the steps that use the new messages.
- `docs/user/machines.md` "Update the daemon"; `needs-you.md` rows; CHANGELOG.

**Done when**:

- unit tests accept a valid example of every new message and tool and reject invalid ones;
- `/version` reports protocol 2;
- integration tests show a protocol 1 `hello` online but unusable with the update commands, a different build giving the warning item, and the same build giving none;
- a test installs the served package and `orchestrator-daemon --version` prints the build the server reports;
- a test reads the package name in the documented update commands (`docs/user/machines.md` and the "Needs you" item) and checks it against the name of the package the server serves, so the Help can never name a package that is not installed.

*Done 2026-10-05.* Choices made in the step, written into the specs (01, 02, 05, 09):

- **What goes into the build identifier**: the first 16 hexadecimal digits of the SHA-256 of the bundled script (with a placeholder where the identifier is then written) and of the package's `package.json` (`apps/daemon/scripts/bundle.ts`). It changes with any change of the bundled code (the daemon's, the protocol's, a library's, or esbuild's output) and with the package's name or version; never with the time, the machine or the folder (esbuild names bundled files relative to `apps/daemon`; comments are left out). A comment, or code the bundle does not use, gives the same build. `pack.ts` writes it next to the package (`<package>.build`), where the server reads it; `/version` returns it. A daemon run from its sources has no build.
- **Protocol 1 messages stay readable**: every protocol 2 field of a daemon message (the build, push results, changed files, "head moved") reads as null when absent. The daemon sends them null until steps D, F and H fill them.
- **Lot 3 failure reasons** `ci_failed` (counted), `ci_timeout` and `review_branch_moved` (not counted) exist from this step, so the server can map the new end reasons (01, section 3.7); `push_failed` comes with step F.
- **The new tools before their steps**: `ci_status` answers "no pull request yet" (true until step F); `review_approve` and `review_request_changes` are refused with `INVALID_TRANSITION` outside a review run (06, section 4.5), that is always until step H. Every agent sees the three tools in its list; the server refuses those its role does not have.
- **Update commands everywhere**: the refused-protocol item ("Update the daemon on …", which already existed) now shows the same five commands as the protocol 1 item, instead of `npm install -g` and a restart.
- A protocol 1 daemon on a server of the same version number reads "Daemon 0.3.0 is older than this Orchestrator, though both say version 0.3.0" (servers built from `main` during lot 3).

### [x] C. Local fake GitHub

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

*Done 2026-10-05.* Choices made in the step (`docs/dev/testing.md`, "The fake GitHub"; ADR 0033):

- **Real Git repositories**: each repository of the fake is a bare repository on disk (`/tmp/od-test-github-*`, removed by `close()`), written by Git plumbing commands with no user or system Git configuration. The REST API's commits and trees are real Git objects, so `git http-backend` (behind the handler of `@orchestrator/daemon/testing/git-http-server`, mounted on the fake's own address) serves what the REST API wrote, and a push is seen by the REST API at once. The clone URL is `<fake url>/<owner>/<name>.git`; the end-to-end server now gives it as `gitBaseUrl`.
- **One token check**: Git requests use the same accounts and the same permission check as the REST API. The token is the Basic password with any non-empty user name; Contents read to fetch a private repository, Contents write to push, and a pre-receive hook refuses a push that touches `.github/workflows/` without Workflows write. A public repository is fetched without a credential.
- **Which runs exist** follows "Events that trigger workflows": a repository lists its workflows (`skeletonWorkflow()` is the skeleton's CI; none by default, "No CI found"); `pull_request` runs start when a pull request is opened, reopened or its head moves, never while it has a conflict; `push` runs only for the listed branches. A repository's `ci` script says what a new run does (`queued` for a test to move on, `success`, failures with logs, or `none`).
- **Mergeable**: the first read after a change of the head or the base answers `null`, the next one the computed value (`git merge-tree`).
- **The owner's actions** (merge or squash, close, **Update branch**, a commit on any branch) and CI (start, complete with failures, commit statuses) are functions of the fake, and controls of the end-to-end server (`fake-github-controls.ts`).
- **No test reaches GitHub** (rule 9): `vitest.setup.ts` makes `fetch` refuse github.com in every test file and fails the test that tried, naming the request; every test home's Git configuration sends github.com URLs to a closed local port (`real-github-guard.ts`). The end-to-end server installs the same `fetch` guard.
- What GitHub's documentation does not say, or what later steps depend on, is listed under step E, "Assumptions to confirm on the real GitHub".
- **For step H**: every agent sees the review tools in its tool list since step B, and the server refuses them by role (06, section 4.5). Step H decides whether the relay should list only the tools of the run's purpose.

### Step D: Push by the daemon, split in three (rule 15)

Split approved by the owner on 2026-10-06. The token is used by the daemon, under the owner's user, in a repository an agent has just worked in. The agent, or instructions hidden in a page it read, can change that repository's Git configuration and files, the owner's global Git configuration, `~/.netrc`, and anything else the owner's user can write. So no command holding the credential ever reads a file an agent can change (**isolation by construction**, 05 section 7). This applies to lot 2's fetch as well: it ran in the bare clone and read that configuration, so `http.proxy` with `http.sslVerify=false` could send the token to another host, and a program started by Git after the helper refused another host (`core.askPass`, `core.sshCommand`, a remote helper) could ask the daemon's socket for it.

What stays open, written in 05 section 7 and Help: an agent runs as the owner's user. It can read the daemon's machine token (`~/.orchestrator/config.json`) and connect to the server in the daemon's place, and a process it leaves running can read the environment of Git processes started at the same time. A stolen GitHub token allows writing to and administering every repository of the owner's account (`docs/user/github-token.md` asks for "All repositories" and Administration). The fix, agents running under a separate system user from the daemon, is in lot 7's scope (10); lot 4's plan decides whether to bring it forward.

### [x] D1. Credentialed Git isolated, and the push at submission

- **The isolated credentialed command** (05 section 7), used by every fetch and push:
  - a new bare repository per command in the run folder (`git init --bare --template=`), with a random name, removed afterwards. Its configuration is written by the daemon only. It borrows the bare clone's objects through `objects/info/alternates`, and `core.alternateRefsCommand` is set to a shell built-in that prints nothing, so Git never starts `for-each-ref` in the bare clone. The commits it already has come from refs the daemon writes into it before a fetch (`refs/orchestrator/have/*`, read from the bare clone by a local command without the credential);
  - Git is given the run's URL from `run.start`, never a remote name: `https`, or `http` only to a loopback address (tests). On the command line: `-c credential.helper=` then the daemon's helper, `credential.useHttpPath=true`, `http.followRedirects=false`, `protocol.allow=never` with only `https` (or `http` in tests) allowed, `core.hooksPath=/dev/null`, `push.recurseSubmodules=no`, `gc.auto=0`;
  - the environment is an allowlist: `PATH`, `LC_ALL=C`, `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `HOME=/nonexistent` (a folder the owner's user cannot create, so `~/.gitconfig`, `~/.netrc` and `~/.git-credentials` are never read), the proxy variables of the daemon's own environment, and the helper's socket and key. The owner's global and system Git configuration is ignored (Help > Troubleshooting and `docs/dev/setup.md` say so, for a Git proxy setting);
  - **the helper** answers only for the exact protocol, host (port included) and repository path of the run's URL, and only the first request: any refused request closes the socket for good;
  - **time limit**: the new global setting **Longest push** (`pushTimeoutSeconds`, default 60 seconds, 10 to 600) bounds every credentialed command (fetch included). The command runs in its own process group, which is stopped when the limit is reached; a push then reads `failed`, `unreachable`, with a message giving the limit. A change or reset is refused unless MCP call timeout plus Longest push stays below the Claude Code MCP tool timeout (a message names the three settings). `run.start` limits carry the value (protocol 2 is not released yet: no version change).
- **Fetch**: the fetched pack stays a pack (`fetch.unpackLimit=1`) and is moved into the bare clone's `objects/pack` (`.pack` first, then `.rev`, then `.idx`). The daemon then sets `refs/remotes/origin/*` to the fetched refs with one `update-ref --stdin` transaction, deleting the ones no longer on GitHub. Those local commands never carry the credential environment.
- **Push**: the ticket branch's head is read **once** from the bare clone; that hash is pushed (`<hash>:refs/heads/<ticket branch>`, no `+`, `--no-follow-tags`, `--porcelain`), and it is the one reported, as the facts' head and as `pushed.head`. The result is read from the porcelain lines and the exit code, never from translated text: `!` with `non-fast-forward` or `fetch first` is `diverged`; any other refusal is `refused` with GitHub's own message, masked; no ref line is `unreachable` (or `refused` for an authentication failure). The isolated repository holds no other branch or tag, so nothing else can be pushed.
- **At `ticket_submit`**: when the worktree is clean and the branch has commits ahead, the daemon pushes before forwarding the call, with the result in the facts.
- **The daemon's local Git commands** (in the bare clone and the worktree) run with `core.hooksPath=/dev/null`, `core.fsmonitor=false`, `gc.auto=0`, `maintenance.auto=false`, the same `HOME` and global and system configuration ignored, and `ORCHESTRATOR_RUN_ID` for a run's commands, so a program they start is stopped with the run. `git status` for the facts runs with an explicit `--git-dir` and `--work-tree`, never following the worktree's `.git` file. What stays open (filters and other programs named in the bare clone's configuration) is a known limit in 05 section 7.
- **Server**: `git.credential` for `push` only for a run with status `running`, of the asking machine, for the run's own repository, and never for a `review` run; `fetch` stays allowed for `dispatched`, `starting` and `running`.
- **Specs and docs**: 05 sections 4.2, 4.9 and 7 (the isolated command, how the fetched objects and refs reach the bare clone, the known limits, and "Dedicated user recommended" corrected: a dedicated user for the daemon protects the owner's personal files, not the machine token from agents); 10, lot 7 (agents under a separate system user, lot 4 may bring it forward); 04 section 8 (Longest push); Help: Troubleshooting, Settings, the known limit; CHANGELOG.

**Done when** daemon tests (real Git, the fake GitHub's Git server, the fake `claude` for the submission) show:

- for each way to leak (hooks; `credential.*` helpers; `url.*.insteadOf`, `pushInsteadOf` and a changed remote URL; `http.proxy`, `http.sslVerify`, `http.curloptResolve`, `http.extraHeader`; `core.sshCommand`, `core.gitProxy`, `remote.*.vcs`, `remote.*.uploadpack`; `core.askPass`; `include.path` and `includeIf`; the same in the test home's global configuration and `~/.netrc`), the changed configuration in place and the token not leaving: a listener on another host receives nothing; spy programs never run or receive nothing; the fake GitHub sees only the expected requests; no file under the test home or the run folder holds the token afterwards; `/proc` sampled during a slowed push shows no token in any process's arguments or environment;
- regression tests of lot 2's fetch (a proxy with `sslVerify=false`; `core.askPass` after a refused host) that fail on `main`;
- no process holding the credential environment runs Git with the bare clone as its repository (Git's trace2 events of the whole command tree); a fetch after one new commit on GitHub downloads only that commit's objects;
- the push at submission, with the facts' head equal to `pushed.head`, and the hash read once even when the branch moves between the read and the push;
- a branch and an annotated tag on the branch's own commit not pushed, with `push.followTags=true` in the bare clone and in the test home's global configuration;
- never forced: a GitHub branch with commits the local one lacks is `diverged` and left unchanged;
- a push stopped at **Longest push** reported `unreachable`, its process group gone; the settings rule refusing a sum too large;
- the server refusing a push credential for a run of another machine, another repository, a review run and a finished run;
- every feature used exists in Git 2.40 (doctor's minimum), checked against Git's release notes and recorded in 05.

*Done 2026-10-06.* Choices made in the step:

- `HOME=/nonexistent` instead of an empty private folder: the owner's user cannot create it, so nothing can be planted in it while a command runs.
- `maintenance.auto=false` matters: without it a fetch starts `git maintenance run --auto --detach`, a detached process holding the credential's variables.
- A `file://` URL (the runner tests' remotes) runs in the isolated repository without a credential helper; `http` is allowed only to a loopback address.
- The bare clone's `remote.origin.url` and `credential.helper` are now set with `--replace-all`: an agent adding a second value made preparation fail ("has multiple values").
- `credential-leaks.test.ts` removes the test home's proxy variables, because `no_proxy` made curl ignore a planted proxy and hid the attack: the two lot 2 regression tests were checked to fail with `main`'s daemon (the planted proxy received `x-access-token:<token>`; the planted askpass got the token from the socket). With the isolated command allowed to read the global configuration, 6 of the 9 cases fail.
- A fetch after one new commit brings at most 4 objects: `index-pack --fix-thin` adds the delta base of the new tree.
- Not run on Git 2.40 itself: the versions are checked against Git's release notes (05 section 7.1).
- **Longest push also limits the download of the project at a run's start** (the session's choice, kept by the owner on conditions): one setting for now, its description saying so and that the first download on a new machine is the longest. A separate fetch limit was deliberately not added; it may be needed later, because the rule tying Longest push to the Claude Code MCP tool timeout concerns only the push at submission, inside the agent's tool call, while a first download of a large project can need far longer than a push. A download stopped by it ends the run `crashed` (failure `crash`, counted as a failed attempt, like any preparation failure), with the machine's words naming the setting and its value, now shown on the run page (`endDetail`) and in Help > Machines > Troubleshooting.
- ADR 0034 records the isolated credentialed command, the options rejected and what stays open.

### [x] D2. Run ends, reviews and preparation

- **The push at a run's end**, best effort, for an `implement` or `fix_review` run that ends with commits not on GitHub (failure, give up, timeout, **Stop run**), after the scope stop and the sweep, with the result in `run.state`. A failure never changes the run's outcome.
- **"Ending"** on the server: a run the server ended by `run.stop` (**Stop run**, ticket cancelled, `not_active`) whose machine has not reported its end yet. The server records when it sent `run.stop`; a `push` credential is given from then until the end report, and at most MCP call timeout plus Longest push after it. A run the daemon ends by itself is still `running` until its end report. Refusals tested: another machine, another repository, a review run, a run ended longer ago than that bound.
- **A review run** never pushes; at its end the daemon compares the branch head with the one it started from, and a moved head ends it with `review_branch_moved` and "head moved".
- **Preparation**: when a new worktree is made, the local ticket branch is fast-forwarded to GitHub's when GitHub's contains it (after **Update branch**); a branch checked out by a waiting or paused run is never moved. A diverged branch is left as is; its push reports `failed`, `diverged` (the `push_failed` failure and its "Needs you" item come with step F).
- **Changed Git configuration**: at each run's end the daemon compares the bare clone's configuration and hooks with what it wrote, restores them, and writes an event saying what changed. No "Needs you" item, and the push is never refused for it (common tools such as husky set `core.hooksPath` on their own).
- `git merge` added to the builders' allowlist; the common rules say how to bring the base branch in (`git merge origin/<base>`).

**Done when** daemon tests show the end push at a failure, a give-up, a timeout and **Stop run**; a failed end push leaving the outcome unchanged; a review run never pushing and reporting a moved head; the fast-forward after **Update branch**; a diverged branch reported and never overwritten; a waiting run's branch left alone; a changed configuration restored with its event; and server tests show the "ending" refusals above.

Added by the owner at the start of the step (2026-10-06):

- the end push gets its credential on every way a run can end with commits not on GitHub: a failure, a give-up, each timeout (idle and Longest run), reminders used up, **Stop run** and a cancelled ticket, one test per way, each waiting for the branch on the Git test server;
- the end push reports through `run.state` before the end is reported, and a slow or failed end push never keeps the worktree, the session or the run's processes alive beyond Longest push;
- the Git configuration is restored under the bare clone's lock, and a waiting or paused run of the same repository still works afterwards (its worktree, its commit author); the event says what changed in plain words, with no file content that could hold a secret;
- `git merge`: the rules added and why those forms are in the summary, and the profiles' versions go up; the allowlist smoke test stays the owner's, in step N;
- a push answered "not found" (HTTP 404) is `refused`, not `unreachable` (test first).

*Done 2026-10-06.* Choices made in the step:

- **Review runs** (the owner's position, question 5 of the step): the worktree is detached at GitHub's head of the ticket branch as fetched at preparation; the local branch is neither created nor moved, and a local branch ahead of GitHub is left alone. "Head moved" is true when the worktree's head or the local ticket branch differs at the end from the start (both kept in `state.json`; a head that cannot be read counts as moved); a moved head replaces the run's end reason with `review_branch_moved`. The branch reported at the end is the worktree's head. A ticket branch not on GitHub fails the preparation ("nothing to review"). 05 section 4.2 is reworded; no protocol change (`headMoved` and `review_branch_moved` came with step B).
- **Order at the end**: session closed, scope stopped and processes swept, branch read (review: head moved), worktree removed, configuration restored, end push, end reported. So the session, the processes and the worktree are gone before the push starts; the report waits for the push (at most Longest push, plus the wait for the bare clone's lock). The daemon's acknowledgement of `run.stop` still comes once the run has ended, as in lot 2.
- **The end push** is tried for every end reason but `submitted`, when the branch holds commits on no branch fetched from GitHub. After any successful push the daemon sets `refs/remotes/origin/<branch>` to the pushed head (no credential), so the end push after a submission push, and `status`, do not count it as not on GitHub.
- **Ending on the server**: `runs.stop_sent_at` (set at every `run.stop`: **Stop run**, a cancelled ticket or a ticket marked done, `not_active`) and `runs.end_reported_at` (migration 0015). The bound uses the current global settings at the credential request.
- **Restored by the last run of a repository to end** (owner's change after reading the branch): while another run's worktree of the same repository exists (working, waiting or paused), a run's end restores nothing and sends no event, since every worktree reads the bare clone's configuration and hooks: restoring would silently take away what that run set up (husky's hooks after its `npm install`) and blame the wrong run. The credentialed commands never read that configuration, so waiting costs nothing for the token. The event's words say the change was found when the run ended, by that run or an earlier one, not that the run made it.
- **The "ending" window** counts from `run.stop`, and the session's close and the process sweep come out of it: with the smallest settings (MCP call timeout 5 seconds, Longest push 10 seconds) a slow stop can close it before the push asks; the end push is then refused, the outcome unchanged and the commits stay on the machine (05 section 7).
- **The restored configuration's event needs a protocol field**: `run.state` `ended` gains `gitConfigRestored` (plain words, null when nothing changed; protocol 2 is not released, so no version change). The server writes `run.git_config_restored` (Activity: "Git configuration restored"), masked again; no "Needs you" item. What is restored and kept is in 05 section 7.1.
- **Fast-forward at preparation** uses `update-ref` with the old head; a ticket branch checked out by another worktree (a waiting or paused run) fails the new run's preparation with a plain message instead of Git's, and is never moved.
- **`git merge` rules**: `Bash(git merge origin/*)`, `Bash(git merge --no-edit origin/*)` and `Bash(git merge --abort)` (03 section 2.2): only branches fetched from GitHub can be merged; `--abort` undoes a merge the agent cannot finish; a conflict is finished with `git add` and `git commit`. The versions of the Architect and the Web Developer go up by themselves at the server's next start (their files and the common rules changed).

### [ ] D3. Server and ticket page

- The branch head on GitHub stored per ticket from every `pushed` result (submission and end), with the machine holding commits not on GitHub.
- The ticket page shows "on GitHub" or "on machine X, not on GitHub yet"; **Run now**'s machine rule (07 section 3) applies only to commits not on GitHub, and the next run takes a pushed branch from GitHub on any machine.
- Help (Tickets), CHANGELOG.

**Done when** a daemon test shows **Run now** taking a pushed branch on another machine; server tests show the stored head and the machine rule; the end-to-end test shows both states on the ticket page, on desktop and phone.

### [ ] E. GitHub layer and the owner's check of the real GitHub

- `apps/server/src/github/`: pull requests (open, update, close, reopen, read merged and mergeable), Actions runs, jobs and log excerpts, commit statuses, comment reviews, each with its refusals turned into "Needs you" GitHub items naming the permission. The token check gains the read probes of Actions, Pull requests and Commit statuses.
- `tools/smoke/github-smoke.sh`, for the owner only (rule 9), with no Claude quota. It uses this layer and the daemon's push code on a repository the owner names, after a typed `yes`. It refuses:
  - the Orchestrator's own repository (read from this checkout's `origin`);
  - CI, or a run without a terminal;
  - a repository that does not exist.

  **The token** is read from the terminal without echo (`read -s`), held only in the script's process memory, passed to its Node.js helper through a pipe on standard input, never written to disk, never in arguments, the environment of child processes, shell history or output, and masked in any message GitHub sends back. Its steps, each printing `PASS` or `FAIL`:
  1. push a branch `orchestrator-smoke-<time>` with one commit through the per-command credential helper; no credential left in the scratch clone's configuration; a push and a REST request with a wrong token are refused; a push to a repository name of the owner's account that does not exist answers "Repository not found" (A1, A4, A22, A24);
  2. open a pull request; read it back, printing `mergeable` at the first read and the next ones; a second pull request for the same branch is refused (A5, A6);
  3. wait for CI and read its result (Actions runs and commit statuses): the runs found by the head commit are the `pull_request` runs only; the logs of a job not finished yet; the combined commit status with Actions only (A12, A14, A17);
  4. push a commit with a broken documentation link; wait for the failure; read the failed job's log excerpt through the redirect, and the jobs and steps with their conclusions (A12, A13, A15);
  5. push a commit that repairs the link; wait for CI to pass (the owner's projects require the `ci` check to merge);
  6. post a comment review; check that an approval and a request-changes review on your own pull request are refused as expected (A11);
  7. read the mergeable flag and `mergeable_state` (A10);
  8. ask the owner to merge it on GitHub (the script waits), then detect the merge (`merged`, `GET .../merge` 204); reopening it is refused; list the push runs of the merge commit without waiting for them (A9, A16, A20, A21);
  9. open a second pull request from a second branch made from the default branch as it was before step 8, changing the same line as the first: it conflicts (`mergeable` false after `null`, `mergeable_state`), no `pull_request` run starts, and **Update branch** through the API is refused; ask the owner to close it without merging; detect that, find it with `state=all`, reopen it through the API and close it again (A8, A9, A10, A18, A19, A20);
  10. *only when the owner gives a second token* (`--restricted-token`, read and handled like the first: never on disk, in arguments, history or output; the script says exactly which permissions to give it, the test repository only and the shortest expiry, and reminds the owner to delete it afterwards; Metadata read and Contents read only, on the test repository): a push is refused, and opening a pull request, reading Actions runs and reading commit statuses each answer 403 with `X-Accepted-GitHub-Permissions` naming the permission; with Contents write added to it by the owner, a push changing `.github/workflows/` is refused with GitHub's text (A2, A3, A23). Without that token the step prints `NOT ATTEMPTED`.

  It also prints each assumption below with `PASS`, `FAIL` (with what GitHub answered) or `NOT ATTEMPTED`: a difference is fixed in the fake, with its test, before step F.

  At the end it deletes its branches on GitHub and its scratch clone (the merged commit stays on the default branch). If it stops early, it says what it left (branches, pull requests) and how to remove them. Checked in CI with `bash -n` and a dry run against the fake GitHub.
- The guard of `tools/smoke/lib/` also covers scripts that act on the real GitHub.

**Assumptions to confirm on the real GitHub** (written in step C): what the fake does that GitHub's documentation does not say, or that later steps depend on. The documented behaviours are cited in `apps/server/test/fake-github/` and `docs/dev/testing.md`. "Step" is the smoke script's.

| # | The fake does | Relied on by | Step |
|---|---|---|---|
| A1 | A push over HTTPS with the token as password and `x-access-token` as user name is accepted | D | 1 |
| A2 | A push touching `.github/workflows/` without Workflows write: the ref is rejected with "refusing to allow a Personal Access Token to create or update workflow `<file>` without `workflows` permission" | D, F (`push_failed` reason) | 10 |
| A3 | A push without Contents write: HTTP 403, "Permission to <owner>/<name>.git denied to <login>." | D, F | 10 |
| A4 | A wrong token on Git: 401, and Git says "Authentication failed" | D | 1 |
| A5 | A new pull request's `mergeable` is `null` in the creation answer, then `true` or `false` at a later read | F, J | 2 |
| A6 | A second open pull request for the same head and base: 422, `errors[].message` "A pull request already exists for <owner>:<branch>." | F | 2 |
| A7 | No commits between the base and the head: 422, "No commits between <base> and <head>" | nothing (the server opens a pull request only for commits ahead) | not checked |
| A8 | `GET /pulls?head=<owner>:<branch>&state=all` finds a closed pull request | F, J | 9 |
| A9 | `PATCH` `state: open` reopens a pull request closed without merging while its branch exists; a merged one: 422 | J | 8, 9 |
| A10 | `mergeable_state` is `clean` when mergeable, `dirty` on a conflict, `unknown` while computed | nothing (only `mergeable` is used) | 7, 9 |
| A11 | A review on your own pull request: APPROVE answers 422 with `errors` `["Review Can not approve your own pull request"]`, REQUEST_CHANGES `["Review Can not request changes on your own pull request"]`; COMMENT is accepted with state `COMMENTED` | H | 6 |
| A12 | A `pull_request` run's `head_sha` is the pull request's head commit, and `GET /actions/runs?head_sha=` finds the runs of that commit; a push to a branch the workflow does not list starts no run | G1 | 3, 4 |
| A13 | Job logs: 302 to another host, downloaded without the API's `Authorization`; each line starts with a timestamp with seven decimals (`2026-10-05T10:00:00.0000000Z`); steps open with `##[group]`; a failing step ends with `##[error]Process completed with exit code 1.`; the later steps are `skipped` | G2 | 4 |
| A14 | The logs of a job not finished yet: 404 | G2 | 3 |
| A15 | The skeleton's CI failing on a link: job `docs-links` fails at step "Check documentation links", and job `ci` fails too | G2 | 4 |
| A16 | A merge into the default branch starts its `push` runs on the merge commit | J (not waited for) | 8 |
| A17 | With Actions only, the combined commit status is `pending` with no statuses ("GitHub Actions generates checks, not commit statuses") | G1 | 3 |
| A18 | **Update branch** through the API is refused for a pull request with a conflict (no `pull_request` run while it has one is documented) | G1, J | 9 |
| A19 | `mergeable` becomes `false` (after `null`) when the base branch changes the same lines | J | 9 |
| A20 | A pull request closed by the owner reads `state` `closed`, `merged` false, and `GET .../merge` 404; a merged one 204 | J | 8, 9 |
| A21 | The merge commit's message ("Merge pull request #<n> from <owner>/<branch>") and the squash commit's ("<title> (#<n>)") | nothing (printed only) | 8 |
| A22 | A wrong token on the REST API: 401 "Bad credentials" | E | 1 |
| A23 | A refusal names the permission in `X-Accepted-GitHub-Permissions`: `pull_requests=write` to open a pull request, `actions=read` for runs, `statuses=read` for statuses | E | 10 |
| A24 | A push to a repository that no longer exists, or that the token cannot see: GitHub answers "remote: Repository not found." and Git says "fatal: repository '<url>' not found" (HTTP 404); the push reads `refused`, since GitHub answered | D2 (`pushResult`), F | 1 (a repository name that does not exist, checked at no cost) |

**Done when** the fake GitHub tests cover every function and refusal, the script passes its dry run, and **the owner has run it once on their test repository with every step `PASS`**. The results are recorded here. A step that fails is settled with the owner before step F.

**The owner's run**: a WSL terminal in the repository. A test repository of their own account with the skeleton (for example the `test0.3.0` project's), its default branch protected or not. The token in hand. Optionally, for step 10, a second fine-grained token on the test repository with Metadata read and Contents read only, to which the owner adds Contents write when the script asks. About 10 to 15 minutes, mostly waiting for CI: 4 workflow runs, each with the skeleton's `docs-links` and `ci` jobs (about 1 to 2 minutes): 3 on the first pull request (opened, broken link, repair) and 1 on the default branch after the merge (the skeleton's CI also runs on pushes to it; the script does not wait for it); none on the second pull request, which conflicts. Actions minutes of a private repository: about 8. Command: `tools/smoke/github-smoke.sh --repository <owner>/<name>` (add `--restricted-token` for step 10).

### [ ] F. Full submission and the pull request

- `ticket_submit` (04 section 3.1, without CI yet):
  - the push result;
  - the criteria;
  - the per-type form checks;
  - listed paths changed on the branch.
- The pull request opened or updated by the server on an accepted submission, its description from the template `agents/templates/pull-request.md`; workflow changes flagged in it and on the ticket.
- Until step G1, an accepted submission ends the run and the ticket goes to `in_review` with the pull request link (lot 2's meaning plus the pull request: the owner checks it).
- Ticket page: pull request link, DoD report with each check's result. `push_failed` with its "Needs you" item. The template `implement.md` and the common rules updated for the full submission.
- `docs/user/`: Tickets ("Submission and the pull request"), Needs you, `github-token.md` rewritten for 0.4.0; CHANGELOG.

**Done when** integration tests with a scripted daemon and the fake GitHub cover each failed check (criteria, type rules, a listed path not changed, the push refused), the pull request opened then updated, the workflow flag, and `push_failed`; Playwright on both viewports shows a submitted ticket with its pull request link and checks.

### [ ] G1. CI: waiting and success

- The polling loop (**GitHub check interval**), restored at server start.
- An accepted submission answers `pending_ci`; the daemon's `waiting_ci` (no nudge, no working time, no idle timeout); the run counts against its account.
- The CI result of 04 section 3.1 (every workflow run of the head commit and its statuses) and **Wait for CI to start** ("No CI found", the submission passes).
- CI passed: `run.stop` `completed`, the run `succeeded`, the ticket `in_review` (replacing step F's end at submission).
- `ci_status` for all roles, cut to **Longest CI log excerpt**.
- The new settings of this step; the run page shows "waiting for CI".

**Done when** daemon and server tests with the fake GitHub show CI passing, no CI found, the idle timeout and working time not counting while waiting, the polling restored after a server restart, and `ci_status` cut to the setting.

### [ ] G2. CI failures, limits and screens

- A failure sent back through `run.input` (template `ci-failed.md`, **Longest CI log excerpt**), the run back to `working`, a new submission checked again from the start.
- **Most CI failures per run** (`ci_failed`, counted).
- **CI wait at submission** (`ci_timeout`, not counted, "CI did not finish" with **Check CI again**, which accepts the stored submission without a session when CI has passed since).
- Ticket and run pages: "waiting for CI", the CI result per run and job; "Needs you"; the settings and their texts (the reworded **CI wait at submission**); Help; CHANGELOG.

**Done when** daemon and server tests show CI failing once then passing in the same session, one failure too many, the timeout then **Check CI again** accepting the stored submission without a session (and finding CI still not finished, changing nothing); Playwright on both viewports shows a ticket waiting for CI, then in review with its CI result, and **Check CI again** from "Needs you".

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
- Clean-up after a merge (owner's choice, option A corrected): the server deletes the ticket's branch on GitHub unless another open pull request uses it (Contents write), and a branch GitHub already deleted counts as deleted. The daemon deletes its local ticket branch when the server says the ticket's pull request is merged and the local head is the head that was merged (nothing unpushed): it never compares commits with the base branch, which a squash merge would defeat. The worktree is already removed at each run's end (except for waiting and paused runs). After a cancellation nothing is deleted (04 section 2: "closed but kept"), so **Reopen** finds the work.
- Help: merging, closed pull requests, conflicts; CHANGELOG.

**Done when** tests with the fake GitHub cover: a merge to `done` (dependents unblocked), a merge during `in_review` with a run active, a pull request closed then reopened, cancel closing it, conflicts, and the clean-up: the GitHub branch deleted after a merge, a branch GitHub already deleted accepted, a branch another open pull request uses kept, the local branch deleted after a squash merge, a local branch with an unpushed commit kept, nothing deleted after a cancellation. Playwright: "Needs you" lists a pull request to merge, which becomes `done` after the fake merge without reload.

### [ ] K. Failures and retries

- **Failed attempts before asking you** and **Most review rounds per ticket** stop a ticket: marked on the board and ticket page, **Run now** refuses, "Needs you" offers **Try again**, **Cancel** and **Mark as done manually**.
- The counted and not counted failures of lot 3 (`ci_failed`, `ci_timeout`, `push_failed`, review failures), each with its `system` comment.
- 04 section 5 rewritten from the code; lot 4's rule on blocking items already in 10.
- Help: "When a ticket keeps failing"; CHANGELOG.

- **A project download at a run's start that fails or is stopped** (GitHub unreachable, the credential refused, **Longest push** reached) is not the agent's failure (owner's decision, lot 3 step D2). It gets a failure reason of its own, is not counted as a failed attempt, and leaves a blocking "Needs you" item, as `push_failed` does. The run page and the ticket's comment say what happened in true words, instead of today's "its Claude Code session stopped unexpectedly or never started". The Help line "Such a run counts as a failed attempt in this version" (Machines > Troubleshooting) is corrected in this step. Until then such a run ends `crashed`, counted, as step D1 left it.

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
  - one criterion: `README.md ends with a link to docs/user/faq.md`. CI is the system's check, not the agent's criterion: a criterion is something the agent can show in its own work (Help > Tickets), and a criterion such as "CI passes" could never be reported met at the first submission, which the server would refuse;
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

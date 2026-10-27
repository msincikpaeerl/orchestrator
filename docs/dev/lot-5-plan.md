# Lot 5 — Implementation plan

> Status: step A done (2026-10-24): this plan, the owner's answers and the spec changes approved, with the owner's simplification of answer 1; step B split into B1 and B2, B1 and B2 done (2026-10-24); step C split into C1 and C2, both done (2026-10-25); step D split into D1 and D2, with side step 5bis E between them, D1 done (2026-10-26); side step 5bis E done (2026-10-27), the owner's probe passed on Claude Code 2.1.311
> Scope: "Lot 5 — Requests and planning" in [10 — Delivery Plan](../specs/10-delivery-plan.md), the items lot 1 moved to lot 5 (the dependency graph, the board's toggle for plan tickets; [lot 1 plan](lot-1-plan.md), steps A and F), and lot 4's "Carried to lot 5" ([lot 4 plan](lot-4-plan.md#carried-to-lot-5)).
> **Lot 5 is done when** the owner submits "a simple website with a contact form" and, after approving the plan and merging pull requests, gets a working website with CI, tests and documentation (made testable below, "What the website must be").

Every session follows the [working rules](working-rules.md). Branches: `lot5/<step letter>-<short-name>`. Steps are done one after the other, in the order below, each in its own session once the previous one is merged (rule 18). No session acts on the real GitHub (rule 9) or starts a real Claude Code session (rule 10): planning runs, the Project Manager's tools and the plan's approval are tested with the fake `claude`, the fake GitHub and the server's own clock. The real GitHub and the real Claude Code are used only by the owner, in step M. Lot 5 is released as version 0.6.0.

## Decisions taken for this lot (2026-10-24)

### Already decided

From the specs and earlier lots; nothing here waits for an answer.

- **Requests** (01 section 3.2, 02 section 5): free text, attached to a project or not (a new project is then the Project Manager's to propose); statuses `open`, `planning`, `plan_proposed`, `closed`; the clarifying questions and answers are comments on the request.
- **Plans** (01 section 3.3, 06 section 4.4): a summary, an optional new project, tickets referring to each other by local keys; statuses `proposed`, `approved`, `rejected`, `superseded`; the plan's tickets exist in `proposed` and are hidden from the board by default; approving moves them to `todo` (and creates the project, if any); rejecting with feedback starts a new planning run and the old plan becomes `superseded` (its tickets `cancelled`); at most **Most tickets per plan** (`maxTicketsPerPlan`, 15, per project; its "Used from version 0.6.0" mark goes in step L).
- **The Project Manager** (03 section 2.1; 06 section 5): role `planner`, model `sonnet`, read-only file tools, Bash `git log` and `git status` only; tools `request.get`, `request.ask`, `plan.propose`, `ticket.update` (a `proposed` or `todo` ticket of its project), the reading tools, `ticket.comment`, `ticket.create`; a planning run ends with `plan_propose`, `request_ask` or `ticket_give_up` (03 section 3, rules for `plan`).
- **The scheduler** (07 sections 1 and 3): a `plan` candidate is created when a request is submitted or a plan is rejected with feedback; category 4, after resumes, reviews and fixes, before `implement`; a planning run counts against its account like any run and is bound by windows, the budget and **Stop new runs**.
- **New projects** (08 sections 3.1 and 3.2): approving a plan that creates a project does what the Projects screen does for a new repository (the skeleton, branch protection when available), and the plan starts with the bootstrap ticket, assigned to the Architect, every other ticket depending on it.
- **Setup wizard steps 3 to 5** (02 section 3): add a Claude account, add a machine, done (suggesting a first request).
- **Every new item kind and event** is covered by `merges.test.ts`'s every-kind guard and `every-event.ts` (lot 3 steps H3, K2); every new automatic start says in its step's summary what it can start by itself and how often at most, and Help says it ("Claude usage", lot 4).

### The owner's answers (2026-10-24)

Step A's questions, answered by the owner: A to every question except 5 and 16, which have the owner's own answers. The specs named carry them (this step).

1. **The daemon for planning runs: A** (05 sections 2, 4.1 and 4.2; 06 section 4.2; 09 section 6; 03 section 3.2). `PROTOCOL_VERSION` 3 in lot 5. A planning run for a new project starts in an empty scratch folder with no repository; for an existing project, in a worktree detached at GitHub's head of the base branch, with no branch of its own, never pushed. **Criteria numbered from 1 in `ticket_submit`** come with this update, everywhere, as 03 section 3.2 said they would ("the next lot that requires an updated daemon"). **An older daemon** (owner's simplification, approval of step A): a protocol 2 daemon stays connected but takes no run at all (it is unusable, as a protocol 1 daemon was from lot 3), and the Queue and the machine page say "Update the daemon to 0.6.0"; so the server never reads an index from 0 again and has a single reading of `ticket_submit`. Nothing special for 0.4.0 (the owner installs the lot 5 daemon for the check). Lot 7's daemon items (**Push again**, the unreadable `state.json`; now lot 8, below) stay there.
2. **What "a working contact form" means: A** (this plan, "What the website must be"). The owner submits a fixed request text so the scenario is repeatable.
3. **How the owner runs and sees the site: A** (this plan).
4. **What its CI, tests and documentation contain: A** (this plan).
5. **Browser tests on the machine: the owner's proposal** (05 sections 2, 3.2, 4.2, 4.3, 4.6 and 8; 01 sections 3.1 and 3.8; 08 sections 3.2 and 3.3; 03 section 2.5; built in **step C**):
   - the owner installs Playwright's system libraries once, with a command Help documents and the owner types (never an agent or a session; working rule 8 binds sessions, not the owner);
   - browsers download into a folder the daemon manages, `~/.orchestrator/browsers/`, through `PLAYWRIGHT_BROWSERS_PATH` set in every session's environment, never the home folder's `~/.cache/ms-playwright`;
   - a new daemon command, `orchestrator-daemon browsers`, typed by the owner, downloads the Chromium of the Playwright version the daemon pins into that folder and checks it starts headless; `doctor` checks it at each `hello` (missing libraries named) and the machine reports the detected capability **`browser-tests`** (01 section 3.8, the closest existing concept), which a `website` or `web_app` project created from 0.6.0 requires by default (01 section 3.1, `required_capabilities`; the owner can remove it in project settings);
   - the website's end-to-end tests run locally for the Web Developer and Quality, and in CI.
   - **What this checked against the rules and specs**: (a) the daemon's folder is closed to agents (05 section 4.6): `browsers/` gets its own deny rules and hook rule like the other entries, so an agent never reads or writes it with a tool or a command naming it; only Playwright, through the variable, uses it. An agent's program could still write there, as npm writes its cache in the home folder: a known limit until lot 6's isolated workspace (05 section 7.2). (b) The Orchestrator's own `pnpm test:e2e` keeps running in the Playwright Docker image (ADR 0021, CLAUDE.md): the libraries are for agents' projects. (c) The owner's earlier choice not to install the libraries (lot 0, for the Orchestrator's own tests) is replaced by this answer for agents. (d) Each project may pin another Playwright version than the daemon's: its own `npx playwright install chromium` adds that revision to the same folder (Playwright keeps one folder per revision and locks it during a download). No conflict found that stops the proposal.
6. **The agents' other restrictions: A** (03 sections 2.1 to 2.3; 05 section 7.2; 08 section 3.3): the Project Manager steers a simple website to kind `website` with file storage and no database; a `web_app` with PostgreSQL stays possible, its integration tests running in CI only until lot 6 (open point below); the rules tell agents to run scaffolders without prompts (`--yes`, a template, `--no-git`) and never to start a dev server in the foreground; npm's cache in the owner's home folder is written by npm itself (a known effect, said in Help); a workflow file needs **Workflows (Read and write)**, which the token already requires (02 section 3.1).
7. **The Technical Writer and Android before their lot: A** (03 sections 2.1 and 4; 06 section 4.4): `plan.propose` refuses an assignee that does not exist (`writer`, `android_dev` until lot 7, Agent management) and the kind `android_app` ("Android projects come with version 0.8.0"); until then the Project Manager adds no `docs` ticket: each feature ticket writes its own user documentation (04 section 3.3).
8. **The bootstrap ticket: A** (08 section 3.2; 06 section 4.4): the Project Manager proposes it (`bootstrap: true`, type `chore`, assignee `architect`, no `blocked_by`); the server adds the fixed criteria of 08 section 3.2 that are missing, from a template in `agents/templates/`, and adds it to every other ticket's `blocked_by`; a plan for a new project without exactly one bootstrap ticket is refused.
9. **The project at approval: A** (01 section 3.3; 02 section 5.3): the plan review shows a form filled in from the plan: name, key (suggested), repository name (checked free) and visibility (private by default). **Approve** creates the repository with the skeleton; the tickets become `todo` and wait for the project to be ready (the queue's existing "not ready" reason); a failed setup has the existing **Try again**. Linking an existing repository stays on the Projects screen.
10. **Planning runs that fail: A** (01 section 3.2; 07 section 6; 02 section 4): a failed planning run (crash, timeout, gave up, reminders used up without a plan) counts on its request; at **Failed attempts before asking you** (2) the request stops, with a "Needs you" item "Planning stopped" and **Try again**; a `plan_propose` refused for its content tells the agent each problem and the run goes on within its limits; **Reject with feedback** starts a new planning run by itself (each one is an owner's click). No new setting.
11. **Clarifying questions: A** (01 section 3.2; 02 sections 4 and 5.3; 04 section 6): as ticket questions: a "Needs you" item and the same answer box, the answer delivered live or by resume, **Waiting run lifetime** unchanged; the request stays `planning` and shows its open question.
12. **Editing a plan before approving: A** (02 section 5.3; 01 section 3.3): title, description, acceptance criteria, type, priority, assignee and dependencies of a plan ticket, and removing a ticket (adding one is not offered); every edit writes an event; **Approve** validates the plan again (limits, assignees, cycles, the bootstrap rule).
13. **Parent tickets (epics): A** (01 section 3.4; 10): left out of lot 5, written as "later" (no lot).
14. **The dependency graph: A** (02 sections 5.3 and 6.3): drawn by the UI with no new dependency, in columns by dependency depth; on a phone, a list ordered by depth. The board's toggle for plan tickets comes in the same step.
15. **Setup wizard: A** (02 section 3): steps 3 and 4 shown on a fresh install only; step 4 has **Skip for now** (the "No machine enrolled yet" item stays until one enrolls); the owner checks them on a throw-away stack; Playwright covers the whole path.
16. **The owner's check: A, with the owner's change** (step M): in the daytime, no window, the daily budget only a safety net so high it cannot stop the scenario halfway (**$15** of estimated usage), **Most tickets per plan** at 6 during the check; the website request creating a new private repository; a second request on `TESTB`, rejected once with feedback, then approved; the graph, the daemon update, the browser check and the wizard on a throw-away stack.

**Delivery plan and vision** (the owner's changes, written in this step, specs only):

- **A new lot 6, "Isolated agent workspace"** (10): sessions run on a machine or environment dedicated to agents (a dedicated Linux machine the owner now has; a dedicated WSL distribution as the fallback on a Windows host), with no access to the owner's personal files or credentials, where agents may use Docker, install packages, run servers and search the web. It unlocks a `web_app` with PostgreSQL tested locally and heavier stacks. Its steps are not planned now. Agent management becomes lot 7 (0.8.0) and Hardening lot 8 (0.9.0); every spec reference is renumbered (lot 6 → 7, lot 7 → 8); closed plans keep their words as records.
- **Operations agents** (00 section 9): a planned evolution after v1, which lot 5's choices must not block.
- **Unraid** removed as a hosting target from the specs and the user documentation (00 section 6, 09 sections 1 and 7.2, 10 lot 8, Help > Machines); the Orchestrator's future host is a dedicated server. ADRs 0010 and 0014 keep their words: an accepted ADR is never edited except its status (08 section 2.3).

### No other daemon change

Protocol 3 holds everything lot 5 changes on the daemon (step B: planning runs and criteria from 1; step C: browser tests). Step C's capability and environment are part of the same protocol version, unreleased until 0.6.0, so they raise nothing again. A step that finds another daemon change stops and asks the owner.

### Lessons of lots 2 to 4, applied in every step

- **Time**: no test waits for a real delay; the server's clock is moved and the loop run by the test (`schedulerTick()`, `ciTick()`).
- **One code path**: a planning run starts through the same path as the others (the scheduler's start, **Run now**'s checks); the queue and the screens give the same reasons in the same words.
- **The owner's processes, step size, rules 9, 10 and 15**: as in lot 4 (test homes under `/tmp/od-test-*`, rule 15 splits proposed before any code).

### CI time

On `main`, `test (1)` and `test (3)` have about one minute of margin under 8 minutes ([testing](testing.md)). Each step keeps it:

- New integration tests use scripted daemons (fast) for the server's rules; the real daemon with the fake `claude` only where the daemon's side changes (steps B and C) and in step K's scenarios.
- Lot 5's end-to-end scenarios go in their own file, `apps/server/test/acceptance-lot5.test.ts`, never in `acceptance.test.ts` or `acceptance-lot4.test.ts`.
- Vitest places files by the SHA-1 of their path and gives each shard a run of them, so **any new test file can move others between shards**. Every step that adds a test file checks the four shards' placement with lot 4 step J's copy of Vitest's split and the measured file times, and gives the shard times in its summary. When `test (1)` or `test (3)` would pass about 7 minutes, the step adds a fifth shard (ADR 0032's rule; `ci.yml` `shard: [1,2,3,4,5]`) rather than eating the margin, or renames the new file to land in a lighter shard when that suffices.
- New Playwright files (requests, plan review, graph, wizard) are checked against the two e2e shards (ADR 0036); a shard above about 6 minutes gets a third.

### What the fakes need

- **Fake `claude`**: scenario steps calling `request_get`, `request_ask` and `plan_propose` (through its existing MCP step), started in a scratch folder with no Git repository (step B), reading `PLAYWRIGHT_BROWSERS_PATH` from its environment (step C, asserted, no browser), the status line's cost per session (step K, as lot 4 step J).
- **Fake GitHub**: nothing new for repository creation from a plan (lot 1's creation and skeleton, with the token's permissions); the skeleton's CI and a bootstrap branch changing `.github/workflows/` (lot 3); a repository name already taken at approval (lot 1's check).
- **Browsers**: no real download in tests. Step C tests `orchestrator-daemon browsers` and the `doctor` check against a fake `npm`, a fake Playwright CLI and a fake Chromium in the test home (`PATH` with fakes, as lot 4 step H's `linkSystemTool`), each failure named (no libraries, download refused, no start).

### What the website must be (answers 2 to 4)

The owner submits exactly: "A simple website with a home page and a contact form. A message sent through the form is saved on the computer running the site, and the visitor sees a confirmation. No e-mail."

- **The contact form works** when: the form asks for a name, an e-mail address and a message; each is checked in the browser and again by the site's own server (an empty field or an invalid address is refused with a message next to it); an accepted message is saved by the site's server as one line in a file of a folder kept out of Git; the visitor sees a confirmation. No e-mail is sent. The stack is the default `website` stack (Astro, TypeScript), with the server adapter that saving needs, recorded by the Architect in an ADR (08 section 3.3 allows a deviation with an ADR).
- **How the owner runs and sees it** (no deployment in v1): following `docs/user/getting-started.md` alone: clone the repository, with the Node.js 24 already installed (nvm), `npm ci`, `npm run build`, `npm start`, open `http://localhost:<port>` in the Windows browser (WSL forwards `localhost`), send a message, see the confirmation, find the message in the file the documentation names, and see an invalid address refused.
- **CI** (08 section 4, the `website` column): install with the lock file, lint and format check, type check, unit tests (Vitest: the checks and the saving), end-to-end tests (Playwright: a valid message confirmed and saved, an invalid address refused), build, the documentation link check, and the final `ci` job needing every other; under 10 minutes; green on `main` after the last merge.
- **Documentation**: README (one screen), CLAUDE.md (at most 150 lines, with the commands, end-to-end tests included), `docs/user/getting-started.md` (run it), a user page with "Send a message" and "Read the messages you received", `docs/dev/setup.md` and `testing.md`, ADRs for the stack, the storage and the test tools, CHANGELOG entries.

## Steps

### [x] A. Plan and spec decisions (branch `lot5/a-plan`, 2026-10-24)

- This plan; the owner's answers above written into the specs they change: 00 (operations agents, the host), 01 (requests, plans, the bootstrap, epics later, the `browser-tests` capability), 02 (wizard, Needs you, requests, plan review, graph), 03 (the Project Manager, the restrictions, criteria from 1, Quality's browser tests), 04 (lot numbers), 05 (protocol 3, planning runs, browser tests), 06 (`request.get`, `request.ask`, `plan.propose`'s validation, criteria from 1), 07 (the `plan` candidate, planning failures, the daemon's version), 08 (sections 3.2 and 3.3), 09 (protocol 3, the targets, no Unraid) and 10 (lot 5, the new lot 6, lots 7 and 8); Help > Machines' "Orchestrator on another computer" without Unraid; CLAUDE.md's "Current state".

**Done when** the owner has approved this plan and the spec changes.

*Done 2026-10-24*: approved by the owner, with one simplification of answer 1 (own commit): no dual reading of `ticket_submit`'s criteria; a protocol 2 daemon stays connected but takes no run at all, the queue and the machine page saying "Update the daemon to 0.6.0"; criteria from 1 everywhere from protocol 3 (specs 03, 05, 06, 07 and 09).

### Step B, split in two (owner's decision, 2026-10-24)

Step B was too large for one session (rule 15): criteria from 1 change about 48 test files and the agents' texts, the planning workspaces about 22 places of the daemon's run. The owner approved the split below and answered the session's questions:

- **Where the count from 1 applies: A.** The server converts the report once, where it receives it; what is stored (lot 4's submissions included), the screens and the pull request text keep their reading. No migration.
- **The field's name: B, the owner's reason.** `ticket_submit`'s field is `number` (from 1), no longer `index`: for a model, "index" suggests counting from 0, the confusion protocol 3 removes. 06 section 4.2 and its example say so. 0 and a number past the last criterion are refused, in the agent's words naming criterion numbers.
- **The outdated daemon's words: A.** The version named is the server's own (0.6.0 once step L sets it), never written as "0.6.0" in the code: the machine page and Needs you's detail say "Update the daemon to <version>: the machine receives no runs until then."; the queue says "its daemon must be updated to <version>", before any other reason.
- **`run.start` of a planning run: A.** `repository` absent for a new project, `ticketBranch` absent for every planning run; the schema refuses any other combination (a planning run has the request as subject and never a ticket branch; only a planning run may have no repository); `commitAuthor` stays required.
- **A resumed planning run: A.** Its folder is kept like any worktree; the detached worktree stays at the commit it started on.
- **Tests before step E2: A.** Only the daemon's tests start a planning run, through the scripted server's `run.start`; no server code for it before step D.
- Also agreed: a planning run of an existing project gets the bare clone's Git configuration restored at its end, as a review run; a scratch folder left by a crash is removed by the daemon's start clean-up; a run still active when its machine's daemon reconnects with protocol 2 follows 05 section 6, with no new code.

### [x] B1. Protocol 3 and criteria from 1 (branch `lot5/b-protocol-3`, 2026-10-24)

- **First** (own commit): the four code comments that say "lot 6" for Agent management (`apps/server/src/agents/routes.ts`, `seed.ts`, `apps/web/src/pages/ticket-form.tsx`, `packages/protocol/src/api/tickets.ts`) say "lot 7".
- `PROTOCOL_VERSION` 3 (rule 13; 09 section 6).
- **Criteria from 1** in `ticket_submit`: the field `number` (description, schema, the server's reading converting it once; 06 section 4.2); the rules and templates name criterion numbers only, "(index 0)" gone (03 section 3.2); the fake `claude`'s and every test's reports.
- The server: a protocol 2 daemon is accepted, connected and **unusable** (09 section 6, lot 3's rule for the previous protocol): no run of any kind; "Update the daemon to <version>" on the machine page, in "Needs you" ("Update the daemon on X") and as the queue's machine reason; "Update the daemon" in Help names 0.6.0; CHANGELOG.

**Done when** `ticket_submit` counts from 1 (a report naming criterion 1 for the first accepted, one naming 0 refused, one past the last refused, each in criterion numbers), a scripted protocol 2 daemon is connected but given no run of any kind with "Update the daemon to <version>" on the machine page, in Needs you and in the queue, and lot 4's scenarios pass unchanged (their daemon now protocol 3).

*Done 2026-10-24*: `DodReport` is the agent's form (`number` from 1, 0 refused by the schema in criterion numbers, a number past the last by the template's words); `StoredDodReport` keeps lot 4's form (`index` from 0) on the ticket, the run and the screens, converted once at `ticket_submit` (`storedReport`) and back for `ticket_get` (`agentReport`). Tests: `tools.test.ts` (0, lot 4's `index`, past the ceiling, the conversions), `submission.test.ts` (criterion 0 and 6 refused through the MCP path, the report kept by index and read back by number), `files.test.ts` (no agent text says "index"), and in `scheduler-reviews.test.ts` a protocol 2 daemon given neither the scheduler's implement and review runs nor **Run now** and **Start review**, with the words on the machine page and in Needs you (and the queue's in `runs/text.test.ts`). No new test file: the CI shards are unchanged.

### [x] B2. Planning workspaces on the daemon (branch `lot5/b2-planning-workspaces`, 2026-10-24)

- `run.start` (protocol 3, unreleased): `repository` absent for a planning run of a new project, no `ticketBranch` for any planning run (09 section 6).
- The daemon: a planning run of a new project in an empty scratch folder `~/.orchestrator/worktrees/<run-id>/` (no clone, no Git, workspace trust for that folder); of an existing project, a worktree detached at `origin/<base>` after the usual fetch, no local branch created, no branch report, never pushed; the clean-up removes either (the start clean-up too); `status` without a ticket branch.
- The fake `claude` started in a scratch folder with no Git repository.
- No planning run starts yet (no candidate before step E2): the daemon's tests start one through the scripted server.

**Done when** daemon tests with the fake `claude` cover both planning workspaces (no Git in the scratch folder, a detached worktree, no branch report, no push, the clean-up, a resume keeping the folder), and the new test file's shard placement is checked with the shard times in the summary.

*Done 2026-10-24*, with the owner's answers (A to all, no split): `run.start`'s `repository` optional and its `ticketBranch` optional, one refine each for "a planning run, and only one, has a request as subject" and "a planning run has no ticket branch, every other run a repository and a ticket branch"; `commitAuthor` still required. Every session's environment gets `GIT_CEILING_DIRECTORIES=~/.orchestrator/worktrees` (05 section 4.3), so Git finds no repository from a scratch folder even when a parent folder is one. A base branch missing on GitHub fails the preparation ("… there is nothing to plan from."). A run's end removes `worktrees/<run-id>/` even when it was not recorded (a stop during the preparation), Git forgetting it at the next preparation. The scratch folder's trust entry is left. `status` lists a planning run as "planning (request <id>, <owner/name> or new project)" (the control socket's runs gain `request`, `repository` and `branch` nullable). Tests: `planning-run.test.ts` (new, five tests: the scratch folder with the daemon's folder inside a Git repository, its resume, the stop during the preparation; the detached worktree with a commit neither reported nor pushed and the configuration restored; the missing base branch), `messages.test.ts` (each refused combination, both planning shapes accepted), `runner.test.ts` (the variable in the session's environment). No CHANGELOG or Help change: no planning run starts before step E2. Shards (local, `vitest run --shard=N/4`): 195, 104, 93 and 62 s (2026-10-22: 209, 113, 94, 63 s); the new file lands in shard 1 (17 s of file time), `tickets/branch.test.ts` moves from 1 to 2 and `projects.test.ts` (27 s) from 2 to 3; no fifth shard.

### Step C, split in two (owner's decision, 2026-10-25)

Step C was too large for one session (rule 15): projects had no required capabilities yet (only agent profiles had them; 02 section 6.5 lists them in Project settings, never built), so the projects' side needs a migration, the API, a settings card and the starts' checks besides the daemon's side. The owner approved the split below and answered the session's questions (A to all):

- **The Playwright pin: A.** The daemon pins Playwright 1.64.1 (current, 2026-10-14) and the revision of its headless Chromium (1248) in `packages/protocol`; the Orchestrator's own end-to-end tests stay on their version and image (ADR 0021).
- **The revision kept with the version: A.** A daemon devDependency `playwright-core` at the pinned version, read by one unit test comparing its `browsers.json` with the pinned revision.
- **What `doctor` checks: A.** The pinned revision's headless shell in `browsers/` (missing: "Run `orchestrator-daemon browsers`"), then `ldd` on it (libraries not found: named, with Help's command), then a start with `--no-sandbox --dump-dom about:blank` within the existing command timeout (Playwright launches without Chromium's sandbox, which Ubuntu 24.04 and later restrict); an output with `<html` is ok and detects `browser-tests`. A warning, never an error, with the link to Help. A project's own revision is not checked.
- **`orchestrator-daemon browsers`: A.** The PATH `doctor` uses (the service's when it is installed); creates `browsers/`; `npx --yes playwright@<pinned> install chromium` with the variable, Playwright's output shown as it comes; then the check above; each failure named with exit code 1 (npx not found, download failed, libraries missing, no start); success ends with restarting the daemon, since capabilities are reported in `hello` only (no new daemon message).
- **Refusals: A.** `browsers/` gets Read and Edit deny rules; the hook gives the folder its own reason (Playwright finds its browsers by itself); a command naming `PLAYWRIGHT_BROWSERS_PATH` is refused (05 section 4.6: no command names it).
- **Help's libraries command: A**, checked by a committed script `tools/smoke/browser-deps-check.sh` in pinned `ubuntu:24.04` and `ubuntu:26.04` images (26.04 is the owner's WSL, 26.04.1 LTS; the dedicated machine's version is not settled), not in CI.
- **Machine page: A.** No new UI: the `doctor` row with its Help link and the detected capability, shown by Playwright with a scripted daemon.
- **Which projects require `browser-tests`: A.** Every `website` or `web_app` project created on the Projects screen from 0.6.0, a new repository or a linked one; the form says so; the owner can remove it in Project settings.
- **The agents' rules: A.** In C2: the builders' and Quality's rules run the end-to-end tests on such a machine and never set `PLAYWRIGHT_BROWSERS_PATH` nor download browsers elsewhere.

### [x] C1. Browsers on the machine (branch `lot5/c-browsers`, answer 5; 2026-10-25)

- `~/.orchestrator/browsers/`, `PLAYWRIGHT_BROWSERS_PATH` in each session's environment (05 section 4.3), deny rules and the hook's rules for the folder and the variable (05 section 4.6, with tests).
- `orchestrator-daemon browsers`: downloads the pinned Playwright version's Chromium into the folder (with `npx --yes playwright@<pinned> install chromium` and the variable), then checks it starts headless; its messages name what is missing. The Playwright version and revision are pinned once in `packages/protocol`, checked current (rule 2).
- `doctor`'s check **Browser tests**: warning (never an error: a machine without it still takes every run of a project that does not require it) with the missing libraries or "Run `orchestrator-daemon browsers`"; ok detects the capability `browser-tests`, reported in `hello`.
- Help > Machines > "Browser tests": the owner's one-time command for the system libraries (its exact form, with `sudo` and nvm's `npx`, checked by `tools/smoke/browser-deps-check.sh` in the pinned Ubuntu 24.04 and 26.04 images), then `orchestrator-daemon browsers`, then the machine page's capability; what agents can do with it, and the known limit (agents on the owner's user, the folder written by Playwright). CHANGELOG.

**Done when** daemon tests (fake `npx`, fake Chromium, fake `ldd`) cover the command's success and each failure, the `doctor` row in each grade, the capability in `hello`, the variable in a session's environment, and the hook's and deny rules' refusals of the folder and the variable; the script passes in both images; Playwright on both viewports shows the check and the capability on the machine page; the new test file's shard placement is checked.

*Done 2026-10-25*: `PLAYWRIGHT_VERSION` 1.64.1 and `PLAYWRIGHT_CHROMIUM_REVISION` 1248 in `packages/protocol`, compared with the `browsers.json` of the daemon's `playwright-core` devDependency (same version), which also checks that Help gives the libraries command of that version. `doctor`'s **Browser tests** looks for `chromium_headless_shell-<revision>/` with Playwright's `INSTALLATION_COMPLETE` and the shell of the processor (x64 or arm64; another processor: a warning), then `ldd`, then `--no-sandbox --dump-dom about:blank` within the existing 10-second command timeout; ok adds `browser-tests` to `hello`'s capabilities. `orchestrator-daemon browsers` creates `browsers/` (mode 700); the download ending without the revision is a failure of its own. The hook refuses the folder and any command naming `PLAYWRIGHT_BROWSERS_PATH` with one reason (`REASONS.browsers`). `tools/smoke/browser-deps-check.sh` passed in `ubuntu:noble-20260930.1` and `ubuntu:resolute-20261006` (the owner's WSL: 26.04.1 LTS); without the libraries step, 26.04 named twenty missing libraries with Help's command. Help > Machines > "Browser tests", CHANGELOG. Tests: `apps/daemon/test/browsers.test.ts` (new: the command's success and five failures, the check in each grade, the capability in `hello`), `apps/daemon/src/browsers.test.ts` (new: the pin, Help's command, the shell's path, `ldd`'s output), `permissions.test.ts` (the deny rule, the folder and the variable refused, Playwright's commands allowed), `runner.test.ts` (the variable in the session, read by the fake `claude`), `machines.e2e.ts` (the warning with its link, the ok check and the detected capability, Help's section). *Changed before the push (owner's request, 2026-10-25)*: Playwright deletes every browser of `PLAYWRIGHT_BROWSERS_PATH` that no install still on disk lists in the folder's `.links/` (checked in `playwright-core` 1.64.1's registry), and npx's cache is not a stable owner. `orchestrator-daemon browsers` now writes the pinned `package.json` and lock (`apps/daemon/src/playwright-install.ts`) into `~/.orchestrator/playwright/` (mode 700), runs `npm ci --ignore-scripts --no-audit --no-fund` there, then that install's `node_modules/.bin/playwright install chromium` with the variable; `npm` not found and `npm ci` failing are failures of their own. `playwright/` gets the deny rule and the hook's reason of `browsers/`. Tests: a fake `npm` and a fake CLI; the lock compared with the pin and with `pnpm-lock.yaml`'s integrity. Shards (local, `vitest run --shard=N/4`): 200, 107, 91 and 63 s; the new files land in shards 3 and 4, `tickets/branch.test.ts` moves from 2 back to 1 and `projects.test.ts` from 3 back to 2; no fifth shard. End-to-end: 176 tests, 8.4 minutes locally, the new test in `machines.e2e.ts`.

### [x] C2. What projects require (branch `lot5/c2-project-capabilities`, answer 5; 2026-10-25)

- `projects.required_capabilities` (migration, empty for existing projects); a `website` or `web_app` project created on the Projects screen (new repository or linked) gets `browser-tests`, the form saying so; Project settings' card "Required capabilities" (02 section 6.5), each change an event.
- A run needs the project's and its profile's capabilities: the queue, **Run now** and **Start review**; the queue's existing capability reason names the missing one. (A planning run needs none, from step E2.)
- The builders' and Quality's rules for the end-to-end tests (03 sections 2.2 to 2.5).
- Help > Projects; CHANGELOG.

**Done when** server tests cover the default for both creations, existing projects unchanged, the edit and its event, the queue's reason, **Run now**'s and the review's refusals; `files.test.ts` covers the rules' lines; Playwright on both viewports edits the card.

*Done 2026-10-25*, with the owner's answers (A to all; the owner added to the agents' rules: never run `playwright uninstall` nor delete downloaded browsers):

1. The card **Required capabilities** as the machine page's capabilities: the list with **Remove**, **Add a capability** (the same tag format), the whole list saved at each change with the event `project.required_capabilities_changed` (the list before and after); read-only for an archived project.
2. No warning on the card when no machine has a capability: the queue says why a ticket waits.
3. The new project form's **Kind** hint says a website or web app will require `browser-tests`, with a link to Help > Machines > "Browser tests"; an Android app requires nothing (Android comes with 0.8.0).
4. A paused run's resume keeps continuing on its own machine without checking capabilities again; a requirement applies from the next run.
5. The browser tests' paragraph in `agents/rules/builder.md` and `reviewer.md` (not in the shared rules, so not in the Project Manager's): run the end-to-end tests with `CLAUDE.md`'s command (Quality when it runs the tests), the machine provides the browsers, `npx playwright install chromium` for another version, never `PLAYWRIGHT_BROWSERS_PATH`, another folder, `--with-deps` or system libraries, `playwright uninstall` or deleting browsers; a browser that cannot start is said in the report or the decision.
6. No hook refusal of `playwright uninstall`: rules only, no daemon change.
7. A new test file with scripted daemons.

`projects.required_capabilities` (migration `0042_project_capabilities`, `[]` for existing projects); `defaultRequiredCapabilities(kind)` and `SetRequiredCapabilitiesRequest` in `packages/protocol` (`Capability` moved to its own module, `daemon/capability.ts`, re-exported by `connection.ts`, to avoid an import cycle); `project.created`'s event gains `requiredCapabilities`. A run needs `runCapabilities(project, profile)` (`scheduler/checks.ts`): the project's, then its profile's others, in the queue, **Run now** and **Start review**. Help > Projects > "Required capabilities", CHANGELOG, specs 02 (section 6.5 as built) and 07 (section 4). Tests: `apps/server/test/project-capabilities.test.ts` (new: both creations and Android, a project created before, the edit with its events and refusals, the queue's reason and **Run now**'s with the project's and the profile's capabilities, **Start review**'s), `files.test.ts` (the paragraph in each builder and review run; the 0.3.0 rules test gains it after the Git section), the two snapshots of the run messages, `activity/text.test.ts`, `projects.test.ts` and `every-event.ts` (the new field, its event; the fixture's web app on a machine without `browser-tests` has it removed), `projects.e2e.ts` (the form's hint, the card edited, Activity, read-only once archived).

### Step D, split in two (owner's decision, 2026-10-26)

Step D was too large for one session (rule 15): every run belongs to a ticket today (the run service, the MCP backend, the waiting run lifetime, the answer's delivery), so a question from a planning run changes all of them, on top of the new tables and three new screens. The owner approved the split into D1 and D2, done in this order: **D1, then side step 5bis E, then D2**. Step D's scope as first planned: tables `requests` and `plans`, comments on requests, the plan tickets' `plan_id`, events; Requests > list, **New request**, request detail; Needs you's question on a request and "Planning stopped"; `request.get` and `request.ask`; nothing starts yet; Help > Requests, Needs you, CHANGELOG.

The owner's answers to D's questions (2026-10-26), A to all:

1. **Order**: D1 now, then 5bis E, then D2.
2. **The split**: D1 and D2 below.
3. **D2's planning run**: a test-only helper inserts a `plan` run and a test planner profile in the database, played by a scripted daemon; the real start is E2's.
4. **`runs.project_id`**: D2 adds `runs.request_id` and keeps `project_id` required (D2's tests use a request on an existing project); E2 makes it optional for a new project's planning run.
5. **The daemon**: `request_get` and `request_ask` in `MCP_TOOLS` change what the daemon's relay offers; part of protocol 3, unreleased, so no new `PROTOCOL_VERSION`.
6. **A request's name**: one global sequence from 1, "Request 7" on screens, `/requests/7`.
7. **Its text's limit**: **Longest ticket description** (`ticketDescriptionMaxLength`); no new setting.
8. **Its title**: none stored; screens show its first line, cut at 120 characters (a display constant).
9. **Its project**: any project not archived, whatever its setup state (a planning run waits for `ready`, E2).
10. **The owner's actions in D**: submit, add a note, answer a question (D2); no edit of the text and no **Close**. When a request is closed or withdrawn is an open point for step F (Open points).
11. **"Planning stopped"**: D1 adds the fields `attempt_count` and `stopped`; the "Needs you" item and **Try again** move to E2.
12. **Events**: `request.created`, `request.commented` (notes, questions and answers), `request.status_changed`.
13. **`request.get`**: the request (number, text, status, project key or none) and its comments oldest first, a page at a time (`cursor`, `next_cursor`) as `ticket.comments`, within `MCP_OUTPUT_MAX_CHARACTERS`, a text above it cut with a marker.
14. **While the question waits**: the request stays `planning`, the run `waiting_human`; the item "Question on request 7: <first line>"; an answer that cannot reach the machine fails the run `machine_offline` (not counted), stays in the comments, and the request goes back to `open`.

### [x] D1. Requests and their screens (branch `lot5/d-requests`, 2026-10-26)

- Tables `requests` (01 section 3.2, with `attempt_count` and `stopped`) and `plans` (01 section 3.3; written from E1), comments on a ticket or a request (never both), the tickets' `plan_id`; events for each change.
- API: create, list, detail, the owner's note; live updates.
- Screens (02 section 5): Requests > list, **New request** (text, a project or "a new project"), request detail (the conversation, its status, the plan's place, empty until F).
- Nothing starts: submitting creates the request `open`.
- Help > Requests (new page); CHANGELOG.

**Done when** server tests cover the creation, list, detail, notes, the refusals (text too long, an archived or unknown project) and the events (every-event guard); Playwright on both viewports submits a request and sees it in the list and on its page.

*Done 2026-10-26*: tables `requests` and `plans`, `comments.request_id` (a comment on a ticket or a request, never both: `comments_target`), `tickets.plan_id` (migration `0044_requests`); `packages/protocol/src/api/requests.ts` (`RequestStatus`, `requestLine`, `REQUEST_LINE_MAX_LENGTH`), the entity `request`, events `request.created` and `request.commented`, the error `request_not_found` and the limited field `request`; `apps/server/src/requests/routes.ts` (`GET`/`POST /api/requests`, `GET /api/requests/:number`, `POST /api/requests/:number/comments`; numbers under the table's lock, so no gap); `apps/web/src/pages/requests.tsx` (loaded on first use) and `apps/web/src/requests/text.ts`. `request.status_changed` (answer 12) comes with the first code that changes a request's status (D2's failed delivery, E2's planning), so the every-event guard can cover it. Tests: `apps/server/test/requests.test.ts` (new, shard 4, 2 s; it moves `credential-leaks.test.ts`, 42 s, from shard 3 to 2, `web.test.ts` to 1 and `projects.test.ts` to 3, both under a second), `every-event.ts` and `event-log.test.ts`, the Activity texts, `apps/web/e2e/requests.e2e.ts` (new) and `login.e2e.ts` (Requests is no longer "Coming in a later version"); e2e shards 4.7 and 5.4 min. Specs 01 (3.2, 3.10) and 02 (5); Help > Requests (new), Settings; CHANGELOG.

### [ ] D2. Questions on a request (branch `lot5/d2-request-questions`)

- `runs.request_id` (a `plan` run's request, no ticket); the MCP backend loads a planning run.
- MCP: `request.get` and `request.ask` (06 section 4.4), their descriptions and `mcp-tools.md` texts.
- The answer (`POST /api/requests/<number>/answer`) delivered live or by resume as for tickets (04 section 6), and its failed delivery (answer 14).
- Needs you: a question on a request, with the same answer box; the request page shows its open question.
- Help > Requests and Needs you; CHANGELOG.

**Done when** server tests cover a question and its answer (live and by resume, through a scripted daemon), a failed delivery, `request.get`'s paging and output size, the events; Playwright on both viewports sees the question in Needs you and answers it.

### [ ] E1. The Project Manager (branch `lot5/e1-project-manager`)

- `agents/pm.md` (03 section 2.1 with answers 6 to 8), the planner rules in `agents/rules/` (03 section 3), the template `plan` (first message: the request, its comments, the project's tickets in summary, the earlier plan and the owner's feedback after a rejection; within `FIRST_MESSAGE_MAX_BYTES`), `ticket.update` for the planner.
- `plan.propose` (06 section 4.4): the limits (**Most tickets per plan**, the ticket text limits), assignees that exist (answer 7), local keys and no cycle, each ticket's criteria, the bootstrap rule and its fixed criteria (answer 8), the kind (answer 7); each refusal in the agent's words from `mcp-tools.md`; an accepted plan makes its tickets `proposed` with `plan_id`, the request `plan_proposed`.
- The allowlist smoke test gains the `pm` profile (03 section 6), run by the owner in step M.

**Done when** server tests cover each refusal and an accepted plan (new project and existing project), the bootstrap's criteria added and its dependencies, `ticket.update` by role; `files.test.ts` covers the planner rules; the smoke script's dry run passes for `pm`.

### [ ] E2. Planning runs started by the scheduler (branch `lot5/e2-planning-runs`)

- The `plan` candidate (07 sections 1 and 3): at a request's submission and after **Reject with feedback**; category 4; projects in turn (a request for a new project counts as its own); a machine with protocol 3, logged into the account; no capability required.
- Failures (answer 10): counted on the request, the stop at **Failed attempts before asking you**, "Planning stopped" with **Try again**; a planning run that ends without a plan after its reminders.
- From step D (answers 4 and 11 of step D): `runs.project_id` optional for a new project's planning run; Needs you's "Planning stopped" and **Try again**, moved from step D.
- The queue's lines and words for a planning candidate; "Started by the scheduler" in its first message.
- Help > Runs > "What starts by itself" (one session per request, then one per rejection; at most **Failed attempts before asking you** failed sessions per request).

**Done when** server tests (scripted daemons) cover a request planned with no owner action, a question then the plan, two failures stopping the request and **Try again**, the order against reviews and `implement` candidates; Playwright on both viewports shows a planning candidate in Activity > Queue.

### [ ] F. Plan review (branch `lot5/f-plan-review`)

- Request detail (02 section 5.3): the summary, the tickets as a list with type, assignee, priority, criteria and dependencies; edits and removal (answer 12) with events; **Approve** (an existing project: tickets `todo`); **Reject with feedback** (the old plan `superseded`, its tickets `cancelled`, a new planning run); superseded plans' history; Needs you's "Plan to approve".
- The board's toggle "Show plan tickets" for `proposed` tickets of a plan (02 section 6.3).
- Help > Requests ("Review a plan"); CHANGELOG.

**Done when** server tests cover each edit, removal, approval with its validation again, rejection with feedback starting a new candidate, the superseded history; Playwright on both viewports reviews, edits, rejects and approves a plan, and shows the toggle.

### [ ] G. A new project from a plan (branch `lot5/g-new-project`)

- The approval form (answer 9): name, key, repository name checked free, visibility; **Approve** creates the project and its repository with the skeleton (08 section 3.1, the existing setup and its **Try again**), requiring `browser-tests` for a `website` or `web_app` (step C2), then the tickets `todo`, waiting for the setup.
- Help > Projects and Requests; CHANGELOG.

**Done when** server tests with the fake GitHub cover an approval creating the project, the repository and the skeleton, the tickets waiting for `ready` then eligible, the bootstrap first by its dependencies, a name taken, a setup failure and **Try again**; Playwright on both viewports approves a new-project plan.

### [ ] H. The dependency graph (branch `lot5/h-graph`)

- One graph component (answer 14) in the plan review and on the board (toggle), columns by depth, the ticket's state and badges; a list by depth on a phone; no new dependency.
- Help > Projects and Requests; CHANGELOG.

**Done when** web unit tests cover the depth computation (a chain, a diamond, independent tickets); Playwright on both viewports shows the graph and the phone's list (screenshots for the owner).

### [ ] J. Setup wizard steps 3 to 5 (branch `lot5/j-wizard`)

- Step 3 (a Claude account: label, plan, optional windows and budget), step 4 (a machine: its commands, waiting for the daemon and its checks, **Skip for now**), step 5 (Done, suggesting a first request); fresh installs only (answer 15).
- Help > Getting started; CHANGELOG.

**Done when** Playwright on both viewports goes through the whole wizard (a scripted daemon enrolling), and through step 4's skip leaving "No machine enrolled yet".

### [ ] K. End-to-end lot 5 test (branch `lot5/k-acceptance`)

- `apps/server/test/acceptance-lot5.test.ts`, with the real server, the real daemon, tmux, the fake `claude` and the fake GitHub:
  - scenario K1: a request for a new website, a question answered, a plan rejected with feedback, a second plan approved with the form; the repository created with the skeleton; the bootstrap then a feature implemented, reviewed by themselves and merged on the fake GitHub; done, the session count recorded;
  - scenario K2: a request on an existing project, the planning worktree detached at the base branch, a plan approved, its tickets in `todo`;
  - scenario K3: a machine whose daemon connects with protocol 2 takes no run (a planning run and an `implement` run wait, the queue saying "Update the daemon to 0.6.0"); the same machine with the protocol 3 daemon then takes both;
  - every process and folder of the test homes cleaned.

**Done when** the three scenarios pass in `pnpm test`, within CI's 8 minutes per shard (placement checked as above).

### [ ] L. Version 0.6.0 (branch `lot5/l-release-0.6.0`)

- Rule 14: every `package.json` and the `/version` test, a dated CHANGELOG section, README's status line, CLAUDE.md's "Current state", the "(from version 0.6.0)" labels removed (`settings.e2e.ts`'s mark moved to a setting of a later version, or the check reworded if none exists).
- Step M's checklist completed with the screens' words and the budget figures from the steps' measured sessions.

**Done when** `pnpm verify` and `pnpm test:e2e` pass with 0.6.0 everywhere, and step M's checklist is final.

### [ ] M. Lot 5 check by the owner (branch `lot5/m-owner-check`)

On `main` once L is merged, from `docs/user/` alone. Tag `v0.6.0` only after this step.

**Back up first, and how to go back**: as in lot 4 step L (`pg_dump` with the 0.5.0 server stopped; the go-back steps with the migrations of lot 5 named in step L).

The owner:

1. **Server and daemon.** Stop new runs on the account; stop the daemon; rebuild and start the server; update the daemon (Help > Machines > "Update the daemon", 0.6.0, protocol 3); start it. The machine page shows it online and usable, no build warning.
2. **Browser tests.** Help > Machines > "Browser tests": the system libraries command, then `orchestrator-daemon browsers`; the machine page shows `browser-tests`.
3. **Claude Code.** If it changed since 2.1.311 (probed in 5bis E): `claude-code-probe.sh`; in any case `allowlist-smoke.sh` for `pm` (new profile) and `architect`.
4. **The wizard** on a throw-away stack (`-p od-wizard`, `PORT=18080`, a shell `ORCHESTRATOR_SECRET_KEY`, `down -v --rmi local` afterwards): steps 1 to 3, step 4 up to the commands then **Skip for now**, step 5; "No machine enrolled yet" in Needs you. No Claude usage, no daemon enrolled.
5. **Settings for the check**: no window on the account, daily budget **$15** of estimated usage (a safety net only), **Most tickets per plan** 6 (global), the account resumed.
6. **Request on `TESTB`**: "Add a FAQ section to README.md with three questions a visitor of this repository might ask, and their answers." The plan (expected: one or two tickets for the Web Developer); **Reject with feedback**: "Two questions only, and put the FAQ in docs/user/faq.md linked from README.md."; the new plan answers it, the first one shown as superseded; **Approve**; the tickets run, are reviewed by themselves; merge each pull request; **Done**.
7. **The website**: **New request**, "a new project", the fixed text above. Answer any question. The plan: a bootstrap ticket for the Architect first, then the website's tickets; the graph on the computer and on the phone. The approval form: name, key (for example `CNT`), repository `contact-form-check`, private; **Approve**. The repository on GitHub with the skeleton; the bootstrap runs, its end-to-end test running on the machine (its run log), CI, review, merge; then each ticket in turn, merged by the owner.
8. **Run the site** from its `docs/user/getting-started.md` alone: clone, `npm ci`, `npm run build`, `npm start`, open the address; send a message, see the confirmation, find it in the file the documentation names; an invalid address refused.
9. **Its repository**: CI green on `main` with the jobs of "What the website must be"; the documentation listed there present and readable.
10. **If the usage limit is reached** during the lot (the check or personal use): `tools/spike/claude-code-spike.sh --scan-limit`, and `--probe-limit` while the limit still shows; otherwise say so.
11. **After the check**: **Stop new runs** on the account; **Most tickets per plan** back to its default.

**Paste back**, one by one: the machine page after items 1 and 2; probe and smoke results; the wizard's end and Needs you's item; `TESTB`'s two plans (the superseded one and the approved one) and their tickets' end; the website's plan (summary, tickets, the graph's screenshots), the approval, the runs of each ticket (purpose, start, status, estimated usage), any question or Needs you item; the site's confirmation and the saved message line; CI's jobs on `main`; the account's "Today" line; the usage-limit capture or "limit not reached".

**Feedback wanted** (the owner's judgement, not pass criteria): the plans' quality (ticket size, criteria a test can check, the PM's questions worth asking), the graph's readability on a phone, the documentation written for someone who never reads the code, the wizard's words.

- **Quota** (estimates, refined in step L): planning runs 3 sessions (`TESTB` twice, the website at least once, more with questions answered by resume); `TESTB`'s tickets 2 to 4 sessions; the website 4 to 6 tickets, each implement and review, the bootstrap the dearest; in all about 15 to 25 `sonnet` sessions, a few dollars of estimated usage. The **$15** budget is the safety net only.
- **A pass**: both requests planned and approved, `TESTB`'s rejection answered by a new plan and the old one superseded; the website repository created by the approval with the skeleton; every ticket `done` through its merged pull request, with nothing done by the owner but answers, approvals and merges; the site working as "What the website must be" says, run from its documentation alone; its CI green with every job listed; the account paused at the end.
- Gaps found are fixed, each with its test; results recorded here.

**Done when** the owner has run the scenario from the user documentation alone and confirmed it, and lot 5 is closed as version 0.6.0.

## Side steps

### [x] 5bis A. Import tickets from a file (branch `lot5bis/a-ticket-import`, 2026-10-25)

An urgent side step, in parallel with step C, outside the order of the steps (owner's decision, 2026-10-25): **Import tickets** on a project's board, from a file Claude writes for the owner on claude.ai. The file's format (06, section 4.6) is the shape of `plan.propose`'s tickets, defined once in `packages/protocol` (`TicketImportEntry`): steps E1 and F extend it rather than copy it. The ticket form's rules (limits, assignee, the cycle search, the creation and its event) moved to `apps/server/src/tickets/rules.ts`, shared by the form and the import. **Most tickets per plan** is used by the import from now on; its "from version 0.6.0" mark is still right.

**Done when** server tests cover a valid import, each refusal, a cycle in the file and a chain through the project's tickets, all or nothing (a refused ticket, a database failure halfway), an unknown field, too many tickets and an archived project; Playwright on both viewports pastes a file, previews a problem, fixes it, imports and follows a link.

### [x] 5bis B. Merge automatically (branch `lot5bis/b-automatic-merge`, 2026-10-25)

A small side step asked by the owner on 2026-10-25, done next, before step D (C2 merged; D not started): on a project where the owner turns on **Merge automatically**, a ticket's pull request is merged by the Orchestrator once Quality approved it and CI is green, so the scheduler keeps going without the owner. Quality is never skipped and the ticket lifecycle (04, sections 1 and 2) does not change: the merge is found by the existing merge detection (lot 3 step J), which moves the ticket to `done`, deletes the branch and unblocks its dependents, once. GitHub's own auto-merge is not used: it needs branch protection with required checks, which private repositories on a free account do not have (`not_available` since lot 1). Specs written in this session, with the session's recommendations; the owner's answers below may change them before any code.

- **The option** is a project field, `merges_automatic` (off by default, also for existing projects), like `reviews_automatic` (lot 4 step D3), not a setting: settings are whole-number limits with a global value and per-project overrides (04, section 8; `SettingDefinition`), while this is a per-project choice with no global value. Project settings' card **Merge automatically**, saved at each change with the event `project.merges_automatic_changed`, read-only for an archived project.
- **The trigger**: Quality's approval applied (`review_approved`, `in_review` → `awaiting_merge`) on a project with the option on marks the merge wanted in the same transaction, with the approved commit (01 section 3.4, `automatic_merge`). A background task, one per ticket at a time (as the pull request's opening, 04 section 3.1), and the server's start for a wanted merge not tried, then makes one try.
- **The checks before the merge**, in order, each failure ending the try (04, section 4, "Automatic merge"): the ticket, read again under its lock, is still `awaiting_merge` with no request for changes standing, the option still on, the project active; the pull request read by itself is open, into the default branch, from the project's repository, its head the approved commit, and not in conflict; the CI result of that commit read again, as the CI wait reads it (04, section 3.1), is **passed**.
- **The merge**: `PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge` with `sha` the approved commit and the method `squash` (answer 1); GitHub merges only if the head is still that commit (409 otherwise). Once merged, the server reads the pull request and hands it to the merge detection (`PullRequestWatcher.seen`), whose transaction locks the ticket and reads its state again, so the next GitHub check finding the same merge does nothing.
- **No automatic retry once the merge request was sent**: a refusal (405, 409, 422, 403 with the permission named) or a lost answer is a failure; a lost answer is settled by the next read of the pull request (merged: done as above, marked automatic; still open: failed). The ticket stays `awaiting_merge`; its "Pull request to merge" item in Needs you says why in plain words and that the owner merges it on GitHub as before.
- **Events**: `ticket.merged_automatically` (the pull request, the commit, the method) and `ticket.automatic_merge_failed` (the reason, masked), then the existing `ticket.pull_request_merged`; the ticket page and Activity say "merged automatically".
- **Token permissions**: no new one (table below).

Token permissions used by this step, from GitHub's "Permissions required for fine-grained personal access tokens" (read 2026-10-25):

| Operation | Request | Permission |
|---|---|---|
| Merge the pull request | `PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge` | Contents (write) |
| Read the pull request and its head | `GET /repos/{owner}/{repo}/pulls/{pull_number}` | Pull requests (read) |
| Read CI on the commit again | `GET .../actions/runs?head_sha=`, `GET .../commits/{ref}/status` | Actions (read), Commit statuses (read) |
| (not used) Whether it is merged; GitHub's async merge | `GET .../pulls/{pull_number}/merge`; `PUT .../merge-async` | Pull requests (read); Contents (write) |

Compared with 02, section 3.1: every permission is already required at that level (Contents: Read and write since lot 1). A pull request that changes `.github/workflows/` needs Workflows (Read and write) to be merged with a token, also already required. No change for the owner's token; only Contents' "why" gains the merge. GitHub's documentation now recommends its newer "Merge a pull request asynchronously" (`merge-async`, an answer to read again later by its id); the plain merge answers at once, which the checks above need (question 2).

**Done when** server tests against the fake GitHub (its merge endpoint with GitHub's documented answers, `operations.ts` and `extract.ts`) cover: a merge done, the ticket `done` once with its events, its branch deleted and its dependents unblocked; the option off (nothing merged); the head changed (409, and moved before the try); CI no longer passed (failed, running again, no CI found); a conflict and a refusal (405, 422, 403 naming the permission) each giving the Needs you reason; a lost answer, merged and not merged; the next GitHub check finding the same merge doing nothing; a skipped review never merged; an archived project; a restart with a merge wanted; **Stop new runs** holding a merge, and **Resume** trying it (answer 7). Playwright on both viewports turns the option on and off, sees it read-only once archived, and sees "merged automatically" on the ticket page. Help > Projects > "Merge automatically" (what it does, the risk of no human review), Needs you, Tickets; CHANGELOG; every-event.ts and `merges.test.ts`'s guard.

**The owner's answers** (2026-10-25): A to every question except 7.

1. The merge method: **squash**, with GitHub's default commit title.
2. The plain merge endpoint (`PUT .../merge`), not `merge-async`.
3. A skipped review is never merged automatically.
4. "No CI found" is never merged automatically.
5. The try happens right after Quality's approval, not after its comment review is posted.
6. Turning the option on wants nothing for tickets already in **Awaiting merge**.
7. **The owner's own answer**: windows and the budget do not block the merge, but **Stop new runs** holds automatic merges ("if I press it, something is wrong with the agents and I don't want their work merged meanwhile"); held merges are tried when the owner resumes, and while held the "Pull request to merge" item says so (04 section 4, 02 section 4, 07 section 5.5). Accounts are paused one by one, so the session holds merges while **any** account has **Stop new runs** (v1 has one account).
8. GitHub unreachable before the merge request is sent: the next GitHub check tries again.
9. The existing "Pull request to merge" item, with the reason first; not shown while a try is wanted or running (unless held).
10. No button to try again: the owner merges on GitHub.
11. A project field.
12. Side step 5bis B, next, before step D.

*Done 2026-10-25*: `projects.merges_automatic` and `tickets.automatic_merge` (migration `0043_automatic_merge`; `AutomaticMerge`, `AutomaticMergeView` and `AUTOMATIC_MERGE_METHOD` in `packages/protocol`); `PUT /api/projects/:key/merges-automatic`; `AutomaticMerger` (`apps/server/src/tickets/automatic-merge.ts`), modelled on the comment review's post: the approval's transaction stores `wanted`, the task stores `sent` under the ticket's lock before the request and settles a lost answer by reading the pull request; tried after the approval, at start, after the watch in each GitHub check (`CiWatcher`'s `automaticMerges`) and after **Resume**. It reads CI again with `CiWatcher.readCommit`, so CI is read as the CI wait reads it. A merge found is handed to `PullRequestWatcher.seen`, which records it once. `mergeable` null lets GitHub's answer decide (405). What it can start by itself: no session, at most one merge request per approval. Quality's comment review on such a project says the Orchestrator merges it (`footer-merged-automatically`). Fake GitHub: `PUT .../merge` (Contents write; 409 for another `sha`, 405 closed, conflicting or a method not allowed) and its documented answers (200, 403, 405, 409, 422) in `github-rest.json`. Web: the **Merge automatically** card, `AutomaticMergeLine` on Needs you's item and the ticket page, three Activity texts. No new Needs you kind (a field of "Pull request to merge"), so `merges.test.ts`'s guard is unchanged. Tests: `apps/server/test/automatic-merge.test.ts` (new, 19 tests, shard 2), `review-comment-text.test.ts`, `every-event.ts` (the option on and off, a merge failed for a pull request GitHub lacks, one settled after a lost answer), `needs-you-merge.test.ts` and `submission-screens.test.ts` (the new field), web `merge-text.test.ts` and `activity/text.test.ts`, `merge.e2e.ts` (the switch, the merge on approval, "Merged automatically") and `projects.e2e.ts` (read-only once archived), on both viewports.

### [x] 5bis C. Long run texts at launch (branch `lot5bis/c-long-launch-messages`, 2026-10-26)

A bug fix outside the order of the steps (owner's report, 2026-10-26): Quality's review of ART-14 (legal notice and privacy policy pages) failed in one second with "tmux new-session failed: command too long". The daemon gave tmux the whole launch command, the instructions after `--append-system-prompt` and the message after `--` included, and the tmux client refuses a command above about 16 KB. A review's instructions are about 7 KB and its message template 7 KB before the ticket's text, so a long ticket passed the limit. A resume (`run.resume`: the owner's answer to a closed session, a CI or conflict round, **Request changes** to a closed session) went the same way. A message to an open session (`run.input`) already went through a tmux buffer, with names only on tmux's command line.

- **The launcher (option A, owner's answer 1)**: the daemon writes the instructions (`system-prompt.md`) and this launch's message (`message.md`) in the run's folder (mode 600, removed with the run), and tmux starts a fixed `sh` script with their paths, which reads them with `cat` (an absolute path, as `sh`) and replaces itself with Claude Code. Claude Code receives exactly the arguments of 05 section 4.3, byte for byte (`printf x` keeps trailing newlines); tmux's command is about 1 KB whatever the texts. Linux's 128 KiB cap on one argument still applies: the first message was already within `FIRST_MESSAGE_MAX_BYTES` (100,000 bytes, 03 section 3.2), and the instructions now are within `INSTRUCTIONS_MAX_BYTES` (100,000 bytes).
- **Two causes, never counted (owner's answer 2)**. A launch the machine cannot do (tmux cannot open the session, a run file cannot be written) ends the run with the new daemon end reason `launch_failed`, failure `machine_problem`: not counted, the machine left out for the ticket, "could not start on <machine>" after **Machine failures before asking you** (07, section 4). Instructions above their cap are refused **by the server, before any run**: the server builds them and knows their size, so **Run now**, **Start review** and the queue refuse with `instructions_too_large` (the profile, the size and the limit), and the scheduler does not start the ticket while it stands; once they are shorter, the usual start works. The ticket's own text never passes its cap: the server has cut it since lot 2 (03 section 3.2). No "Needs you" item for the instructions: a profile's instructions come only from the Orchestrator's own files until lot 7 (Agent management), so the owner cannot shorten them; a test keeps every shipped profile within the cap, and lot 7's profile editing refuses a save above it. **The owner may still ask for the item** (summary of this step).
- **No `PROTOCOL_VERSION` change**: protocol 3 is unreleased until 0.6.0 and holds every daemon change of lot 5 (above, "Protocol 3"); see this step's summary.
- **Words**: the run page says "Failed: its machine could not start Claude Code", then the daemon's detail "Claude Code could not be started on this machine (<tmux's words>). Running it again on this machine will not help until that is fixed, and it is not the ticket's fault."; `machine_problem`'s words drop "in a process scope" (the detail says which). The refusal: "Claude Code cannot be started: the instructions of agent profile Quality are too long (123,456 bytes, the limit is 100,000). Shorten them, then try again. Running it again without changes will not help."

**Done when** with the fake `claude` and the real tmux, a launch with instructions and a first message of 100,000 bytes each (non-ASCII, quotes, `$`, backticks, backslashes), a resume with a message of 100,000 bytes and a message of 150,000 bytes pasted into an open session reach the fake whole; the launcher gives the exact arguments with dash and bash, trailing newlines included; a broken tmux ends the run `launch_failed`; the server refuses instructions one byte over the cap before any run (Run now, the queue, the scheduler) and starts them at the cap; `launch_failed` is not counted and two in a row give "could not start on Laptop". The launch and resume tests and the server tests fail on `main`'s code; the open session's passes there too (that path was already safe).

*Done 2026-10-26*: `LAUNCH_SCRIPT`, `launchCommand` and `writeRunFiles`' `message.md` (`apps/daemon/src/run-files.ts`); `launch_failed` (`RunEndReason`), `INSTRUCTIONS_MAX_BYTES` and the refusal `instructions_too_large` in `packages/protocol`; `instructionsRefusal` (`apps/server/src/scheduler/checks.ts`) in Run now, Start review and the queue, with `profileRunInstructions` shared with `run.start`. Tests: `apps/daemon/test/long-texts.test.ts` (new), `apps/daemon/src/run-files.test.ts` (new), `runs.test.ts` and `scheduler-holds.test.ts` (both causes), `files.test.ts` (the shipped profiles within the cap), `messages.test.ts` (the schema), the web's refusal words. Specs 03, 04, 05 and 07; Help > Runs; CHANGELOG.

### [x] 5bis D. Launch texts emptied by systemd-run (branch `lot5bis/d-scope-expansion`, 2026-10-26)

A bug fix outside the order of the steps (owner's report, 2026-10-26, after 5bis C on the Desktop's service): Quality's review runs of ART-13 started Claude Code 2.1.310 with `--append-system-prompt ""` and `-- ""`, so the agent had neither its rules nor its message, while `system-prompt.md` and `message.md` were written whole. The cause is systemd-run, not tmux nor the wrapper: from systemd 254 it expands `${NAME}` in a scope's command by default (`--expand-environment=`, systemd-run(1)), and it read the launcher's `${i%x}` and `${m%x}` as variables with invalid names, empty ("Invalid environment variable name evaluates to an empty string: i%x, m%x"). The tests ran the launcher without scopes, and the systemd tests never looked at Claude Code's arguments. Every run of a daemon with scopes (the service) on systemd 254 or later was affected, builders', Quality's and planning runs alike, at a first launch and at a resume; before 5bis C, a `${…}` or `$$` inside a text was changed the same way.

- **The fix**: `--expand-environment=no` on every systemd-run when `systemd-run --version` says 254 or later (or cannot be read), never before (the option does not exist).
- **Safety net, daemon**: empty or white-space-only instructions or message start nothing: `launch_failed`, not counted, "Claude Code was not started: the run has no instructions."
- **Safety net, launcher**: a text that cannot be read or reads as empty after the `x` is removed: the script writes why in the run's `launch-error` and exits 1; the daemon ends the run `launch_failed` with those words. A launcher emptied on the way thus fails at once instead of starting an agent without its rules.

**Done when** a launch and a resume through the process scopes, with a fake `systemd-run` that expands as systemd 254 and later do, give the fake `claude` the whole instructions and messages (systemd 259 and 252), in the normal test run, failing on `main`; empty instructions, and a launcher whose `cat` reads nothing, end `launch_failed` without Claude Code; the systemd tests (real systemd-run, opt-in) check the arguments too.

*Done 2026-10-26*: `EXPAND_ENVIRONMENT_SINCE` and `systemdVersion` (`apps/daemon/src/systemd.ts`); `LAUNCH_SCRIPT`'s checks and `launch-error` (`apps/daemon/src/run-files.ts`); the refusal and `launchError` (`apps/daemon/src/run.ts`). Tests: `apps/daemon/test/scoped-launch.test.ts` (new) with `apps/daemon/test/fake-systemd/` (new), `run-files.test.ts`, `systemd.test.ts`. Spec 05; Help > Runs; CHANGELOG.

### [x] 5bis E. A first message never taken (branch `lot5bis/e-first-message-check`, 2026-10-27)

A side step asked by the owner on 2026-10-26 (option A of 5bis D's question 4), done after D1 and before D2: a first message that Claude Code does not take within the session start timeout (seen through its `UserPromptSubmit` hook) ends the run `launch_failed`, not counted, as any failure its machine caused (the machine left out, then "could not start on" at **Machine failures before asking you**); never a block of the whole machine (option B, rejected). The owner checks it against the real Claude Code. In 5bis D, Claude Code started with an empty message sat at its prompt without a word until the idle timeout: a startup dialog shown after `SessionStart`, or a change in how Claude Code takes the message given after `--`, would do the same with nothing to say why.

The owner's answers (2026-10-27, A to all, with one rule for answers 1 and 7):

1. **Which messages**: the first message of every launch, a run's start and every `run.resume` (the owner's answer to a closed session, a CI or conflict round, **Request changes** to a closed session); not the messages sent into an open session (`run.input`, nudges). **Owner's rule**: the message counts as taken at the first `UserPromptSubmit` of the launch whose `prompt` is not empty or white space only, never compared with the message sent: Claude Code may trim or normalise the text, and a healthy run must never end `launch_failed` for that. The exact comparison is only in the probe's checks 7 and 8 (answer 8), where a difference is reported, not a failure of the product.
2. **How long**: the **Session start timeout** setting (30 seconds by default), counted again from `SessionStart`; no new setting.
3. **What the server sees**: nothing new. The run goes `starting` → `working` at `SessionStart` as before; "message taken" is the daemon's own fact; the end reason is the existing `launch_failed` (failure `machine_problem`, not counted, the machine left out for the ticket). No server change, no `PROTOCOL_VERSION` change (`UserPromptSubmit` is only between Claude Code and the daemon's own hook command).
4. **Words** (the run's detail): "Claude Code started but did not take its first message within 30 seconds, the "Session start timeout" setting: a startup dialog or a change in Claude Code is suspected. Running it again on this machine will not help until that is fixed, and it is not the ticket's fault."
5. **A daemon restart**: "message taken" is saved in the run's `state.json`; a run found again with its message not taken gets a fresh window from the restart. A `state.json` written by an older daemon (no such field) counts as taken, so runs in flight during the update never fail for it.
6. **The hook never gets in the way**: for `UserPromptSubmit`, Claude Code blocks the prompt when the hook exits 2 and adds what the hook prints to the agent's context; the daemon's hook command always exits 0 and prints nothing for it, also when the daemon cannot be reached.
7. **The fake `claude`**: a scenario option `firstMessageNotTaken` (it reports `SessionStart` and never takes the launch's message, as Claude Code behind a dialog), and an empty message is never taken, as with the real Claude Code. **Owner's rule**: a test where the hook's prompt differs from the message sent only by trailing white space, and the run goes on.
8. **The owner's check**: the probe (`tools/smoke/claude-code-probe.sh`) gains check 7 (after `SessionStart`, `UserPromptSubmit` arrives with the first message) and check 8 (a `--resume <session id> -- <message>` launch of the same session does the same; one more short `haiku` prompt). Each is `PASS` when the prompt is exactly the message, `INFO` naming the difference when it was taken with another text, `FAIL` when no `UserPromptSubmit` came.
9. **Documentation**: spec 05 (sections 4.2.1, 4.3 and 4.5), Help > Runs, `docs/dev/testing.md` (checks 7 and 8), CHANGELOG.

**Done when** with the fake `claude` and the real tmux: a start and a resume whose message is never taken end `launch_failed` with answer 4's words once the session start timeout passed after `SessionStart`, without Claude Code left running; two such failures in a row give "could not start on Laptop" (not counted); a message taken late but within the window, and one whose hook prompt differs only by trailing white space, let the run go on; a daemon restarted before the message was taken gives a fresh window, and an older `state.json` counts it taken; the hook command exits 0 with no output for `UserPromptSubmit`, the daemon reachable or not. The new launch and resume tests fail on `main`'s code.

**Owner's checklist with the real Claude Code** (rule 10: only the owner):

1. [x] Run `tools/smoke/claude-code-probe.sh` and see `PASS` (or `INFO` with the difference named) on checks 7 and 8; a `FAIL` means this step's check would fail every run: tell the session before merging.
2. [x] Have the probe's new fixtures folder (`apps/daemon/test/fixtures/claude-code-<version>/`) reviewed and committed.
3. After the merge and **Update the daemon** on Desktop WSL, **Run now** on one small ticket: the run reaches "Running" and its agent answers; no "its machine could not start Claude Code".

*Done 2026-10-27*: `UserPromptSubmit` in `HookEvent` and `HookInputs` (`packages/protocol`), so every run's settings declare it; `RunStateFile.messageTaken` (`apps/daemon/src/run-files.ts`, default `true`); in `apps/daemon/src/run.ts`, `messageWaitSince` opened at `SessionStart` (or at a recovery, for a run past `starting`), closed by the first non-empty prompt, checked at each tick while the session is alive. The usage-limit probe's own `UserPromptSubmit` hook is gone (now the daemon's). The fake `claude`: `firstMessageNotTaken`, `firstMessageDelayMs`, `promptTrimmed`, an empty message never taken, and `<folder>.resume.json` for a `--resume` launch. The probe: a third session, `resume`, and checks 7 and 8 (`firstMessageCheck` in `claude-code-probe-fixtures.ts`; the probe's own `/exit` never counts), fixtures gain `resume-hooks.jsonl`. No server change: `launch_failed` was already not counted, left the machine out and led to "could not start on" (`scheduler-holds.test.ts`, step 5bis C). Tests: `apps/daemon/test/launch-message.test.ts` (new, 6 tests, shard 4 by its name; the start, the resume and the restart fail on `main`'s code), `commands.test.ts` (the hook with the daemon unreachable), `runner.test.ts` (the declared hooks), `claude-code-probe.test.ts` (checks 7 and 8 in the dry run, check 8 failing), `claude-code-probe-fixtures.test.ts`. Specs 04 and 05 (sections 4.2.1, 4.5, the run end reasons, section 9's table); Help > Runs; `docs/dev/testing.md`; CHANGELOG.

*The owner's probe, 2026-10-27* (checklist items 1 and 2): `claude-code-probe.sh` on this branch (2026-10-27T17:56:26.305Z, Claude Code **2.1.311**, model `haiku`): checks 1 to 4 and 6 PASS, 5 INFO; **check 7 PASS** and **check 8 PASS**, "UserPromptSubmit has the message exactly" at the start and at the `--resume` launch, so Claude Code takes the message given after `--` as it is, trimmed of nothing. Transcript line types `ai-title` 3, `api-request` 7, `api-request-blob` 17, `api-request-shape` 2, `assistant` 12, `atis-latch` 4, `attachment` 21, `cost-state` 4, `file-history-snapshot` 6, `last-prompt` 5, `mode` 4, `permission-mode` 4, `system` 4, `tools-used` 3, `user` 7; "Unknown to the daemon: `tools-used` 3", a new type the daemon skips as it skips every type it does not read. The fixtures are committed in `apps/daemon/test/fixtures/claude-code-2.1.311/` (with `resume-hooks.jsonl`, new), reviewed first: only the probe's placeholder paths (`<probe>/home/…`) and, as in 2.1.308, the recorder's command in the `Stop` hook summary with paths under `~/` (here the owner's second checkout, `~/orchestrator-dev-2`, where the probe ran); no e-mail address, name, account or organisation id, token, key, cookie or authorization header. The capture scan (`credentialLikeFound`) flags the same two things as on 2.1.308, both harmless: the prompt cache's `expires_at` time in the status line input and the thinking blocks' `signature`. `claude-code-probe-fixtures.test.ts` now checks them: check 6 PASS (`dontAsk` on the kept lines of the probe's and the resume's messages) and check 8 PASS on the recorded resume. `CLAUDE_CODE_VALIDATED_VERSION` stays 2.1.308: raising it waits for step M's item 3, which adds `allowlist-smoke.sh`. Item 3 of the checklist (Run now after the update) is the owner's, after the merge.

## Open points

- **When a request is closed or withdrawn** (owner's answer 10 of step D, for step F): the specs give the status `closed` but not when it is set (at the plan's approval, by the owner withdrawing a request, or both), nor what a withdrawal does to a planning run or a waiting question.
- **The launch without command-line texts** (option B of step 5bis C, kept aside for lot 8, owner's answer 1): `--append-system-prompt-file` for the instructions (documented, never validated: ADR 0002) and the first message sent through a tmux buffer once `SessionStart` arrives would remove Linux's 128 KiB cap on one argument; it changes how Claude Code is driven, so it needs the owner's smoke test with the real Claude Code and an ADR.

- **Automatic merge of a branch behind the default branch** (owner's review of step 5bis B, 2026-10-25; a possible later step, not now): CI and Quality checked the pull request against the default branch as it was at its last push, so two pull requests merged automatically one after the other can reach the default branch never tested together (04, section 4, "Known limit"). A later step could refuse to merge a pull request whose branch is behind the default branch and send it back to its agent to bring the default branch in (`git merge origin/<base>`), so that CI and Quality run again before the merge.
- **No Docker or database for agents** until lot 6's isolated agent workspace: agents cannot use Docker (05 section 4.6) or run a database locally, so a `web_app` with PostgreSQL is tested in CI only, and the Project Manager steers simple requests to file storage (answer 6).
- **Agents on the owner's user** (05 section 7.2): a program an agent runs can write in the home folder (npm's cache, Playwright's downloads into the daemon's `browsers/`); lot 6's isolated workspace removes it, and lot 8 (Hardening) keeps the separate system user for machines that stay shared.
- **The usage-limit signal capture** (lot 4, "Carried to lot 5"): no Claude usage limit was reached in lots 2 to 4. Whenever it happens during lot 5, the owner runs `tools/spike/claude-code-spike.sh --scan-limit`, and `--probe-limit` while the limit still shows (step M, item 10). It is an owner's action, not a code step. If lot 5 does not reach it either, Hardening (lot 8) keeps it.

## Carried from lot 4 and lot 1, where each item went

| Item | Where |
|---|---|
| The usage-limit signal capture (lot 4) | Open points; step M, item 10 |
| The dependency graph (lot 1, step A) | Step H |
| The board's toggle for plan tickets (lot 1, step F; 02 section 6.3) | Step F |
| Parent tickets (lot 1, step A) | Answer 13: later, no lot |
| Criteria numbered from 1 in the tool (lot 4, Q13) | Answer 1: step B |

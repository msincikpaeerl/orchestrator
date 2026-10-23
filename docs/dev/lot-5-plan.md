# Lot 5 — Implementation plan

> Status: step A done (2026-10-24): this plan, the owner's answers and the spec changes approved, with the owner's simplification of answer 1
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
- **Browsers**: no real download in tests. Step C tests `orchestrator-daemon browsers` and the `doctor` check against a fake `npx` and a fake Chromium in the test home (`PATH` with fakes, as lot 4 step H's `linkSystemTool`), each failure named (no libraries, download refused, no start).

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

### [ ] B. Protocol 3: planning runs on the daemon (branch `lot5/b-protocol-3`)

- **First** (own commit): the four code comments that say "lot 6" for Agent management (`apps/server/src/agents/routes.ts`, `seed.ts`, `apps/web/src/pages/ticket-form.tsx`, `packages/protocol/src/api/tickets.ts`) say "lot 7".
- `PROTOCOL_VERSION` 3 (rule 13; 09 section 6): `run.start`'s `repository` absent for a planning run of a new project, and a planning run of an existing project has no ticket branch.
- The daemon: a planning run of a new project in an empty scratch folder `~/.orchestrator/worktrees/<run-id>/` (no clone, no Git, workspace trust for that folder); of an existing project, a worktree detached at `origin/<base>` after the usual fetch, no local branch created, no branch report, never pushed; the clean-up removes either.
- **Criteria from 1** in `ticket_submit` (description, schema and the server's reading; 06 section 4.2); the rules and templates name criterion numbers only, "(index 0)" gone (03 section 3.2).
- The server: a protocol 2 daemon is accepted, connected and **unusable** (09 section 6, lot 3's rule for the previous protocol): no run of any kind; "Update the daemon to 0.6.0" on the machine page, in "Needs you" ("Update the daemon on X") and as the queue's machine reason (words in `queue-text.ts`); "Update the daemon" in Help names 0.6.0. A run still active on a machine whose daemon reconnects with protocol 2 follows 05 section 6 (the owner updates with no run active: step M).
- No planning run starts yet (no candidate before step E2): tests start one through the test harness.

**Done when** daemon tests with the fake `claude` cover both planning workspaces (no Git in the scratch folder, a detached worktree, no branch report, no push, the clean-up), `ticket_submit` from 1 (a report naming criterion 1 for the first, one naming 0 refused), a scripted protocol 2 daemon connected but given no run of any kind with "Update the daemon to 0.6.0" on the machine page, in Needs you and in the queue, and lot 4's scenarios pass unchanged (their daemon now protocol 3).

### [ ] C. Browser tests on the machine (branch `lot5/c-browsers`, answer 5)

- `~/.orchestrator/browsers/`, `PLAYWRIGHT_BROWSERS_PATH` in each session's environment (05 section 4.3), deny rules and a hook rule for the folder (05 section 4.6, with tests).
- `orchestrator-daemon browsers`: downloads the pinned Playwright version's Chromium into the folder (with `npx --yes playwright@<pinned> install chromium` and the variable), then checks it starts headless; its messages name what is missing. The Playwright version is pinned once in `packages/protocol`, checked current (rule 2).
- `doctor`'s check **Browser tests**: warning (never an error: a machine without it still takes every run of a project that does not require it) with the missing libraries or "run `orchestrator-daemon browsers`"; ok detects the capability `browser-tests`, reported in `hello`.
- Projects: a `website` or `web_app` project created from 0.6.0 requires `browser-tests` (the project form and, from step G, the plan's approval); existing projects are unchanged. The queue's existing capability reason names it.
- Help > Machines > "Browser tests": the owner's one-time command for the system libraries (its exact form, with `sudo` and nvm's `npx`, checked in the pinned Ubuntu image, Docker being allowed for images the repository declares), then `orchestrator-daemon browsers`, then the machine page's capability; what agents can do with it, and the known limit (agents on the owner's user, the folder written by Playwright). CHANGELOG.

**Done when** daemon tests (fake `npx`, fake Chromium) cover the command's success and each failure, the `doctor` row in each grade, the capability in `hello`, the variable in a session's environment, and the hook's and deny rules' refusals of the folder; server tests cover the default required capability and the queue's reason; Playwright on both viewports shows the capability on the machine page.

### [ ] D. Requests (branch `lot5/d-requests`)

- Tables `requests` and `plans` (01 sections 3.2 and 3.3), comments on requests (01 section 3.5), the plan tickets' `plan_id`; events for each change.
- Screens (02 section 5): Requests > list, **New request** (text, project or "a new project"), request detail (the conversation, its status, the plan when there is one); Needs you: a question on a request (answer 11), "Planning stopped" (answer 10, used from step E2).
- MCP: `request.get` and `request.ask` (06 section 4.4), the answer delivered live or by resume as for tickets (04 section 6).
- Nothing starts yet: submitting creates the request `open`; the `plan` candidate is step E2's.
- Help > Requests (new page), Needs you; CHANGELOG.

**Done when** server tests cover the request's statuses, a question and its answer (live and by resume, through a scripted daemon), `request.get`'s paging and output size, the events; Playwright on both viewports submits a request, sees the question in Needs you and answers it.

### [ ] E1. The Project Manager (branch `lot5/e1-project-manager`)

- `agents/pm.md` (03 section 2.1 with answers 6 to 8), the planner rules in `agents/rules/` (03 section 3), the template `plan` (first message: the request, its comments, the project's tickets in summary, the earlier plan and the owner's feedback after a rejection; within `FIRST_MESSAGE_MAX_BYTES`), `ticket.update` for the planner.
- `plan.propose` (06 section 4.4): the limits (**Most tickets per plan**, the ticket text limits), assignees that exist (answer 7), local keys and no cycle, each ticket's criteria, the bootstrap rule and its fixed criteria (answer 8), the kind (answer 7); each refusal in the agent's words from `mcp-tools.md`; an accepted plan makes its tickets `proposed` with `plan_id`, the request `plan_proposed`.
- The allowlist smoke test gains the `pm` profile (03 section 6), run by the owner in step M.

**Done when** server tests cover each refusal and an accepted plan (new project and existing project), the bootstrap's criteria added and its dependencies, `ticket.update` by role; `files.test.ts` covers the planner rules; the smoke script's dry run passes for `pm`.

### [ ] E2. Planning runs started by the scheduler (branch `lot5/e2-planning-runs`)

- The `plan` candidate (07 sections 1 and 3): at a request's submission and after **Reject with feedback**; category 4; projects in turn (a request for a new project counts as its own); a machine with protocol 3, logged into the account; no capability required.
- Failures (answer 10): counted on the request, the stop at **Failed attempts before asking you**, "Planning stopped" with **Try again**; a planning run that ends without a plan after its reminders.
- The queue's lines and words for a planning candidate; "Started by the scheduler" in its first message.
- Help > Runs > "What starts by itself" (one session per request, then one per rejection; at most **Failed attempts before asking you** failed sessions per request).

**Done when** server tests (scripted daemons) cover a request planned with no owner action, a question then the plan, two failures stopping the request and **Try again**, the order against reviews and `implement` candidates; Playwright on both viewports shows a planning candidate in Activity > Queue.

### [ ] F. Plan review (branch `lot5/f-plan-review`)

- Request detail (02 section 5.3): the summary, the tickets as a list with type, assignee, priority, criteria and dependencies; edits and removal (answer 12) with events; **Approve** (an existing project: tickets `todo`); **Reject with feedback** (the old plan `superseded`, its tickets `cancelled`, a new planning run); superseded plans' history; Needs you's "Plan to approve".
- The board's toggle "Show plan tickets" for `proposed` tickets of a plan (02 section 6.3).
- Help > Requests ("Review a plan"); CHANGELOG.

**Done when** server tests cover each edit, removal, approval with its validation again, rejection with feedback starting a new candidate, the superseded history; Playwright on both viewports reviews, edits, rejects and approves a plan, and shows the toggle.

### [ ] G. A new project from a plan (branch `lot5/g-new-project`)

- The approval form (answer 9): name, key, repository name checked free, visibility; **Approve** creates the project and its repository with the skeleton (08 section 3.1, the existing setup and its **Try again**), requiring `browser-tests` for a `website` or `web_app` (step C), then the tickets `todo`, waiting for the setup.
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
3. **Claude Code.** If it changed since 2.1.308: `claude-code-probe.sh`; in any case `allowlist-smoke.sh` for `pm` (new profile) and `architect`.
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

## Open points

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

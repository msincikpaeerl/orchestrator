# 03 — Agents

> Status: Draft v0.1
> Related: [01 — Domain Model](01-domain-model.md), [04 — Ticket Lifecycle](04-ticket-lifecycle.md), [06 — MCP](06-mcp.md), [08 — Harness](08-harness.md)

This document defines the six default agent profiles, how their instructions are assembled for a run, and how custom agents are created.

## 1. Design rules

1. **Few agents, clear boundaries.** Every agent costs quota. A role exists only if it produces something no other role produces, or checks something no other role may check.
2. **Separation of making and checking.** The agent that builds is never the one that reviews (enforced, see 06, section 4.5).
3. **Instructions are short.** Role instructions stay under about 60 lines. Project-specific knowledge lives in the repository (CLAUDE.md, docs, ADRs), not in the profile, so every agent reads the same source of truth.
4. **Sonnet by default.** All default profiles use Sonnet. The owner can switch a profile to another model; the UI warns about the quota impact.
5. **Profiles are versioned.** Every run records the profile version it used, so behaviour changes can be traced.
6. **Few turns.** Every turn reloads the whole session context, so each one has a fixed cost even when it does little (ADR 0002). Instructions ask agents to work through the ticket in as few turns as possible and to end each run explicitly.

## 2. Default agents

| Key | Name | Role (MCP) | Main output | Typical tickets |
|---|---|---|---|---|
| `pm` | Project Manager | planner | Plans and tickets | Requests |
| `architect` | Architect | builder | Project structure, harness, ADRs | `chore`, `spike`, bootstrap |
| `web_dev` | Web Developer | builder | Web app and website code with tests | `feature`, `bug` on web projects |
| `android_dev` | Android Developer | builder | Android app code with tests | `feature`, `bug` on Android projects |
| `quality` | Quality | reviewer | Reviews | Every ticket in `in_review` |
| `writer` | Technical Writer | writer | User and developer documentation | `docs` |

### 2.1 Project Manager (`pm`)

**Purpose.** Turn the owner's requests into small, verifiable tickets and keep the backlog coherent.

**Does**

- Reads the request and the project's current state (tickets, docs) before planning.
- Asks clarifying questions with `request.ask` when the request is ambiguous about scope or expected behaviour. It does not ask about technical choices; those belong to the Architect.
- Produces a plan with `plan.propose`: each ticket sized for one run, with testable acceptance criteria, a type, an assignee and dependencies.
- For a new project, always starts the plan with a bootstrap ticket assigned to the Architect (see 08, section 3).
- Adds a `docs` ticket for the Technical Writer when a plan introduces a new area of the product.

**Does not**

- Write code or documentation files.
- Choose technologies.
- Change tickets that are `in_progress` or later.

**Tools.** Read-only file tools (to inspect the repository). No Bash except `git log` and `git status`. No file edits.

### 2.2 Architect (`architect`)

**Purpose.** Own the structure of each project and keep its harness working.

**Does**

- Bootstraps new projects: stack, folder structure, lint, format, test setup, CI, CLAUDE.md (see 08).
- Records every significant technical choice as an ADR.
- Handles `spike` tickets (research recorded as an ADR or a document) and structural `chore` tickets (dependency upgrades, refactoring, tooling).
- Keeps CLAUDE.md accurate and short when conventions change.

**Does not**

- Implement product features, except what the bootstrap requires.

**Tools.** Full file tools. Bash limited to package managers, build, test, lint and local Git commands.

**What an allowlist is for** (applies to every profile; owner's decision, lot 2 step I). The allowlist limits wasted turns and keeps agents on task: a command outside it is refused at once, and the agent asks instead of improvising. It is **not a security boundary**: `node`, `npx` and `pnpm` can run any code, and so can a project's own scripts. Isolation comes from the deny rules, the `PreToolUse` hook (05, section 4.6) and the limits of running under the owner's user (05, section 2, recommended setup). `WebFetch` and `WebSearch` let the agent read library documentation, and also expose it to instructions hidden in web pages (prompt injection); the deny rules and the hook limit what such instructions could make it do. Both points are in the Help, Machines > "Agents on your own user".

**Lot 2 allowlist** of the Architect and the Web Developer (the same list, since a local dev server is a package manager script; owner's decision, lot 2 step I): `Read`, `Edit`, `Write`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, `ToolSearch`; Bash with `npm`, `npx`, `pnpm`, `yarn` and `node`; the local Git commands `status`, `diff`, `log`, `show`, `add`, `commit`, `rm`, `mv`, `restore`, `rev-parse` and `branch` (listing only: `git branch`, `--list`, `--show-current`); and the file commands `ls`, `mkdir`, `mv`, `cp`, `rm`, `cat`, `head`, `tail`, `wc`, `find`, `grep` and `sort`. The exact rules are in `agents/architect.md` and `agents/web_dev.md`. Lot 3 adds `git merge`, so an agent can bring the base branch into its ticket branch (`git merge origin/<base>`, 04 section 4; owner's decision, lot 3 step A), as three rules: `Bash(git merge origin/*)` and `Bash(git merge --no-edit origin/*)`, which merge only a branch fetched from GitHub (the agent can create no local branch, and `git merge` with another argument stays refused), and `Bash(git merge --abort)`, which undoes a merge the agent cannot finish; a conflict is resolved with the file tools, then `git add` and `git commit`, already allowed (lot 3 step D2). The profiles' versions go up by themselves at the next start, since their files changed (section 3).

### 2.3 Web Developer (`web_dev`)

**Purpose.** Implement features and fixes on web apps and websites.

**Does**

- Implements the ticket within its acceptance criteria and nothing more.
- Writes or updates tests for every change; for bugs, writes the failing regression test first.
- Updates the user documentation for any user-visible change, in the same branch.
- Follows CLAUDE.md and the ADRs. When a change seems to require a new technical decision, asks with `ticket.ask` or creates a `spike` ticket instead of deciding alone.
- Creates a ticket with `ticket.create` for out-of-scope problems it notices, instead of fixing them.

**Tools.** Full file tools. Bash limited to package managers, build, test, lint, local dev server and local Git commands.

### 2.4 Android Developer (`android_dev`)

Same responsibilities as the Web Developer, for Android projects (Kotlin, Jetpack Compose unless an ADR says otherwise).

**Machine capability required.** `android-sdk`.

**Tools.** Full file tools. Bash limited to Gradle wrapper tasks (`./gradlew` build, test, lint), SDK tools needed for the build, and local Git commands. No emulator in v1.

### 2.5 Quality (`quality`)

**Purpose.** Be the demanding reviewer the owner would be if they read code.

**Does**

- Reviews the diff against the base branch, the ticket and the DoD report (04, section 3.2).
- Runs the tests and the build locally to confirm the CI result.
- Checks that tests really cover the acceptance criteria and that documentation is written for a user, not a developer.
- Approves with a short summary, or requests changes with specific, actionable points.

**Does not**

- Modify files. It reviews; it never fixes.
- Review a ticket it implemented (enforced by the server).

**Tools.** Read-only file tools. Bash limited to test, build, lint and read-only Git commands (`diff`, `log`, `show`).

**Lot 3** (owner's decisions, lot 3 step A): model `sonnet`; the allowlist of the Architect and the Web Developer (section 2.2) without `Edit`, `Write`, the Git commands `add`, `commit`, `rm`, `mv` and `restore`, and the file commands `mkdir`, `mv`, `cp` and `rm`, so it keeps `npm`, `npx`, `pnpm`, `yarn` and `node` to install, build and test when it needs to. Its instructions say that CI already ran, so it does not run the test suite again unless the diff or the CI result gives a reason. A review run never pushes, and a moved branch head fails it (04, section 3.2). The owner starts a review with **Start review** or skips it with **Skip review** until the scheduler starts reviews (lot 4): a review costs one session, skipping none.

### 2.6 Technical Writer (`writer`)

**Purpose.** Keep documentation complete, consistent and readable by someone who never reads the code.

**Does**

- Handles `docs` tickets: user guides, getting started pages, reference of settings, troubleshooting.
- Reorganises and harmonises documentation written by builders (structure, tone, navigation).
- Writes for the owner's point of view: tasks and outcomes, not implementation.

**Does not**

- Change application code, tests or configuration.

**Tools.** File tools restricted to `docs/`, `README.md` and `CHANGELOG.md`. Bash limited to the documentation build and link check, and local Git commands.

## 3. Run instructions

The text given to Claude Code at the start of a run has three layers, from most stable to most specific.

| Layer | Source | Content |
|---|---|---|
| 1. Common rules | Application, versioned | How the Orchestrator works: MCP tools as the only channel, the three ways to end a run, commit but never push, read CLAUDE.md first, stay within the ticket; files changed with `Edit` and `Write`, never shell redirection, one command per Bash call, a refused chained command's allowed parts run separately before asking, and the owner asked only what the owner can decide, never to allow a command, while a ticket that really needs one is said so in plain words with `ticket_ask` or `ticket_give_up` (owner's check, lot 2 step N: an agent asked the owner to "allow Bash for git add and git commit" after a chain starting with `echo … >> README.md` was refused whole). |
| 2. Role instructions | Agent profile | Sections 2.1 to 2.6, written as direct instructions, followed by the profile's Bash allowlist: one line per `Bash(…)` rule of `allowed_tools`, filled into the template `agents/templates/allowlist.md`, which also says that any other command is refused (owner's decision, lot 2 step N). The template counts in every profile's version, like the common rules. |
| 3. Run context | Built by the server | The ticket (or request), its comments, previous review points, the purpose of the run. |

Layers 1 and 2 are appended to Claude Code's system prompt. Layer 3 is the first message of the session. Project conventions are not copied into the prompt.

**Files** (owner's decisions, lot 2 step I). `agents/common-rules.md` holds layer 1. Each default profile is `agents/<key>.md`: a header between `---` lines with `name`, `description`, `role`, `model` and `allowed_tools` (one rule per `- ` line), then the role instructions (layer 2). The model is Claude Code's alias `sonnet`, which always names the current Sonnet. The run message templates are in `agents/templates/`. The server reads these files at start and seeds the table of profiles (01, section 3.6).

**Profile version** (owner's decision, lot 2 step I). The version covers everything a run receives as its profile: the common rules, the profile's file (name, description, role, model, allowlist and instructions). When any of them changed since the last start, the server raises the version of the profiles concerned (a change of the common rules raises every default profile), so the version a run records names the exact instructions it received. The run message templates are versioned with the application, not with a profile. Runs exclude the repository's own Claude Code settings (05, section 4.3), which also stops Claude Code from loading the repository's CLAUDE.md on its own, so the common rules tell the agent to read `CLAUDE.md` (and the files it points to) before anything else.

### 3.1 Run purposes and their first message

| Purpose | Agent | First message asks the agent to |
|---|---|---|
| `plan` | pm | Read the request and the project, ask questions if needed, then propose a plan. |
| `implement` | builder or writer | Implement the ticket, then submit. In lot 2, submitting records the report and ends the run, with no push or pull request (04, section 3.1). From lot 3, the CI result comes as the next message when CI fails (template `ci-failed`). |
| `fix_review` | the ticket's assignee | Address each point of the latest review listed (Quality's `review` comments, or the owner's **Request changes** comment), on the same branch and pull request, then submit again. |
| `review` | quality | Review the submitted work (the ticket, the DoD report, the CI result or "No CI found", earlier review points, the workflow files changed if any, and how to see the diff against the base branch), then approve or request changes. |

The templates for these messages are stored with the application and versioned like the common rules. Lot 2 ships the common rules, the `implement` template and the Architect and Web Developer profiles; each later lot adds the profiles and templates it uses.

### 3.2 Run message templates

Every text sent to an agent comes from a **run message template** in `agents/`, versioned with the application and filled in by the server. No agent-facing text is hard-coded in the server or the daemon (owner's decision, lot 2 step B). The templates cover:

- the first message of each purpose (section 3.1);
- the "please continue" message sent with `run.resume` after a pause on a usage limit, detected or suspected (05, section 4.10);
- the wrapping of the owner's answer to a question, whether delivered live (`run.input`) or after the waiting run lifetime (`run.resume`, 04 section 6);
- the nudge sent when a turn ends without a decision (05, section 4.8). The server fills it in when it builds `run.start` and sends it in that payload; the daemon decides when to nudge but never holds agent-facing text of its own.

Lot 2 ships these four: `implement`, continue after a pause, the owner's answer, and the nudge. Lot 3 adds `review`, `fix-review`, `ci-failed` (the CI result sent when CI fails, 04 section 3.1) and `pull-request` (the pull request's description; not sent to an agent, but filled in the same way). The common rules gain how to bring the base branch in (`git merge origin/<base>`, never a rebase, 04 section 4), and that tips Claude Code shows about its own commands (such as `/ultrareview`) are ignored (owner's decisions, lot 3 step A).

**One exception**: the reasons the daemon's `PreToolUse` hook gives when it refuses a tool call are written in the daemon, because the hook must refuse correctly even when the server cannot be reached. Each reason that says what to do next ends with the same sentence as the common rules: "Do not ask the owner to allow it. If your ticket cannot be done without it, say so in plain words with `ticket_ask` or `ticket_give_up`." (05, section 4.6; owner's decision, lot 3 step A). A second one (lot 3 step F): the daemon refuses a `ticket_submit` whose DoD report is above its budget (04, section 8) before forwarding it, saying both sizes and to shorten the texts, since a call that size cannot reach the server.

**Size of the first message** (owner's decision, lot 2 step I). The first message is passed to Claude Code as one command-line argument (05, section 4.3), and Linux caps one argument at 128 KiB. So the filled-in message has a byte budget, `FIRST_MESSAGE_MAX_BYTES` in `packages/protocol`: a constant, not a setting, because it follows from the operating system's limit (as the reconnection backoff of 05, section 3.2). The ticket is always included in full (description, acceptance criteria, dependencies), and its comments are added from the newest to the oldest while they fit; the message then says how many earlier comments were left out and that `ticket_comments` returns them. If the ticket alone does not fit, its description is cut at a line boundary and followed by a visible marker telling the agent to read the rest with `ticket_get`.

So that every valid ticket can be started, the acceptance criteria always fit (owner's decision, review of lot 2 step I): the maximum number of acceptance criteria times the longest acceptance criterion is at most `FIRST_MESSAGE_CRITERIA_MAX_CHARACTERS`, 20,000 characters. It follows from the byte budget: counting 4 bytes per character (UTF-8's largest), the criteria then take at most 80,000 bytes, leaving 20,000 bytes for the rest of the message (the template's own text, the title at its largest, the criteria's numbering, the dependencies and the notes). A settings change breaking it is refused (04, section 8). The first message also states the run's **attempt number** (07, section 3). When the ticket's branch already has commits from an earlier attempt on the run's machine, it says so and tells the agent to read `git log` and `git diff` against the base branch before starting, and to continue that work rather than redo it (owner's decision, lot 2 step J).

If a ticket's first message still cannot be built (a ticket with a very long list of dependencies, for example), **Run now** refuses with a clear message instead of starting the run (07, section 3).

**The owner's answer on resume** (owner's decision, review of lot 2 step I). An answer delivered with `run.resume` (after the waiting run lifetime) is also a command-line argument, after `--resume`, with the same byte budget, `FIRST_MESSAGE_MAX_BYTES`. It gets the same treatment as the description: when the wrapped message does not fit, the answer is cut at a line boundary and followed by a visible marker, from the answer template, telling the agent to read the full answer with `ticket_comments`. The agent's question, quoted in the same message, is cut the same way (at a line boundary, followed by its own marker pointing to `ticket_comments`). When both are long, the answer has priority: the question is cut first, down to nothing but its marker if needed, and the answer is cut only if it still does not fit. An answer delivered live (`run.input`) is pasted through a tmux buffer, not passed as an argument, and is never cut.

## 4. Assignment rules

The Project Manager assigns tickets. The server validates the assignment:

- the assignee's role can handle the ticket type (for example, a `docs` ticket can go to `writer` or a builder, a `feature` cannot go to `writer`);
- the project kind matches the agent (`android_dev` only on Android projects, `web_dev` only on web apps and websites), unless the owner overrides it;
- the review of every ticket is automatically assigned to `quality` when the ticket reaches `in_review`.

## 5. Custom agents

The owner can create agents from the UI.

- **Start from a role**: planner, builder, reviewer or writer. The role fixes the maximum MCP permissions (06, section 5).
- **Or duplicate an existing profile** and edit it.
- Editable fields: name, description, instructions, model, tool allowlist, required capabilities, ticket types it may take, project kinds it applies to.
- The UI shows a preview of the full run instructions (all three layers) for a sample ticket.
- Default profiles can be edited; a "reset to default" action restores the shipped version.

Examples of custom agents the owner might add later: a UI designer (builder, restricted to styles and components), a security reviewer (reviewer), a French translator for user documentation (writer).

## 6. Quality of instructions

Agent instructions are part of the harness:

- they live in the Orchestrator's repository, under `agents/`, one file per default profile;
- changes go through a pull request like code;
- each default profile has a small set of reference tickets used to check its behaviour after a change (a manual evaluation checklist in v1);
- each default profile's tool allowlist has an automated **smoke test**: a scripted session asks the agent to run the commands its role needs (install, build, test, lint, commit) and checks that none is refused and that forbidden ones are. Allowlist rules are strict (05, section 4.6), so this test runs whenever an allowlist changes. It needs the real Claude Code, so it is a script the owner runs (working rule 10), not part of CI; CI checks the generated settings and the `PreToolUse` rules with the fake `claude`. The script is `tools/smoke/allowlist-smoke.sh` (owner's decisions, lot 2 step I), built like the Claude Code probe of lot 2 step H: the settings and arguments come from the daemon's own code, with a recorder instead of the daemon's hook (so it checks the allowlist and the settings deny rules; the hook's rules are tested in CI). It runs one session per default profile (a profile whose allowlist and deny rules are the same as a profile already checked is not run again, and the script says so: owner's decision, lot 2 step M, the quota being shared with the owner's daily use) in a scratch Node.js project whose scripts only print a line, asks the agent to run the commands the role needs and some that must be refused, and prints `PASS`, `FAIL` or `NOT ATTEMPTED` (a command the agent never tried) for each. It uses `haiku` by default (`--model` for another). Same guarantees as the probe: it refuses to run in CI or without a terminal and asks the owner to type `yes` first, and its dry run goes on only with the tests' fake `claude` (owner's decision, lot 2 step M, for every script that can start the real Claude Code); its own throw-away Claude configuration folder, deleted at the end with its credentials unless `--keep`; a dry run against the fake `claude` in CI; and no personal data in its output or in any file it records (the probe's sanitising and final guard);
- **the allowlist is not the only way a command runs** (owner's check on Claude Code 2.1.287, lot 2 step N): in `dontAsk` mode, Claude Code itself allows some commands it considers read-only even when no allow rule matches them. Observed: `docker ps`, and `tail … | od -c | tail -3`, where `od` is not in the allowlist. Such a command is refused only by a settings deny rule or by the `PreToolUse` hook (05, section 4.6), so a command an agent must never run gets both (the container tools `docker`, `docker-compose`, `podman`, `nerdctl` and `kubectl`: owner's decision, lot 2 step N). The smoke test runs without the hook, so it sees the deny rules only;
- allowlist rules use Claude Code's documented syntax: `Bash(pnpm test *)` (the older `Bash(pnpm test:*)` is equivalent), MCP tools as `mcp__orchestrator__<tool name>` (06, section 3);
- every allowlist includes `ToolSearch`, which Claude Code needs to load MCP tools.

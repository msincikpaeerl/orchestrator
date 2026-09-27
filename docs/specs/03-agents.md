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

**Lot 2 allowlist** of the Architect and the Web Developer (the same list, since a local dev server is a package manager script; owner's decision, lot 2 step I): `Read`, `Edit`, `Write`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, `ToolSearch`; Bash with `npm`, `npx`, `pnpm`, `yarn` and `node`; the local Git commands `status`, `diff`, `log`, `show`, `add`, `commit`, `rm`, `mv`, `restore`, `rev-parse` and `branch` (listing only: `git branch`, `--list`, `--show-current`); and the file commands `ls`, `mkdir`, `mv`, `cp`, `rm`, `cat`, `head`, `tail`, `wc`, `find`, `grep` and `sort`. The exact rules are in `agents/architect.md` and `agents/web_dev.md`.

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
| 1. Common rules | Application, versioned | How the Orchestrator works: MCP tools as the only channel, the three ways to end a run, commit but never push, read CLAUDE.md first, stay within the ticket. |
| 2. Role instructions | Agent profile | Sections 2.1 to 2.6, written as direct instructions. |
| 3. Run context | Built by the server | The ticket (or request), its comments, previous review points, the purpose of the run. |

Layers 1 and 2 are appended to Claude Code's system prompt. Layer 3 is the first message of the session. Project conventions are not copied into the prompt.

**Files** (owner's decisions, lot 2 step I). `agents/common-rules.md` holds layer 1. Each default profile is `agents/<key>.md`: a header between `---` lines with `name`, `description`, `role`, `model` and `allowed_tools` (one rule per `- ` line), then the role instructions (layer 2). The model is Claude Code's alias `sonnet`, which always names the current Sonnet. The run message templates are in `agents/templates/`. The server reads these files at start and seeds the table of profiles (01, section 3.6).

**Profile version** (owner's decision, lot 2 step I). The version covers everything a run receives as its profile: the common rules, the profile's file (name, description, role, model, allowlist and instructions). When any of them changed since the last start, the server raises the version of the profiles concerned (a change of the common rules raises every default profile), so the version a run records names the exact instructions it received. The run message templates are versioned with the application, not with a profile. Runs exclude the repository's own Claude Code settings (05, section 4.3), which also stops Claude Code from loading the repository's CLAUDE.md on its own, so the common rules tell the agent to read `CLAUDE.md` (and the files it points to) before anything else.

### 3.1 Run purposes and their first message

| Purpose | Agent | First message asks the agent to |
|---|---|---|
| `plan` | pm | Read the request and the project, ask questions if needed, then propose a plan. |
| `implement` | builder or writer | Implement the ticket, then submit. In lot 2, submitting records the report and ends the run, with no push or pull request (04, section 3.1). |
| `fix_review` | same builder | Address each review point listed, then submit again. |
| `review` | quality | Review the submitted work, then approve or request changes. |

The templates for these messages are stored with the application and versioned like the common rules. Lot 2 ships the common rules, the `implement` template and the Architect and Web Developer profiles; each later lot adds the profiles and templates it uses.

### 3.2 Run message templates

Every text sent to an agent comes from a **run message template** in `agents/`, versioned with the application and filled in by the server. No agent-facing text is hard-coded in the server or the daemon (owner's decision, lot 2 step B). The templates cover:

- the first message of each purpose (section 3.1);
- the "please continue" message sent with `run.resume` after a pause on a usage limit, detected or suspected (05, section 4.10);
- the wrapping of the owner's answer to a question, whether delivered live (`run.input`) or after the waiting run lifetime (`run.resume`, 04 section 6);
- the nudge sent when a turn ends without a decision (05, section 4.8). The server fills it in when it builds `run.start` and sends it in that payload; the daemon decides when to nudge but never holds agent-facing text of its own.

Lot 2 ships these four: `implement`, continue after a pause, the owner's answer, and the nudge.

**Size of the first message** (owner's decision, lot 2 step I). The first message is passed to Claude Code as one command-line argument (05, section 4.3), and Linux caps one argument at 128 KiB. So the filled-in message has a byte budget, `FIRST_MESSAGE_MAX_BYTES` in `packages/protocol`: a constant, not a setting, because it follows from the operating system's limit (as the reconnection backoff of 05, section 3.2). The ticket is always included in full (description, acceptance criteria, dependencies), and its comments are added from the newest to the oldest while they fit; the message then says how many earlier comments were left out and that `ticket_comments` returns them. If the ticket alone does not fit, its description is cut at a line boundary and followed by a visible marker telling the agent to read the rest with `ticket_get`.

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
- each default profile's tool allowlist has an automated **smoke test**: a scripted session asks the agent to run the commands its role needs (install, build, test, lint, commit) and checks that none is refused and that forbidden ones are. Allowlist rules are strict (05, section 4.6), so this test runs whenever an allowlist changes. It needs the real Claude Code, so it is a script the owner runs (working rule 10), not part of CI; CI checks the generated settings and the `PreToolUse` rules with the fake `claude`. The script is `tools/smoke/allowlist-smoke.sh` (owner's decisions, lot 2 step I), built like the Claude Code probe of lot 2 step H: the settings and arguments come from the daemon's own code, with a recorder instead of the daemon's hook (so it checks the allowlist and the settings deny rules; the hook's rules are tested in CI). It runs one session per default profile in a scratch Node.js project whose scripts only print a line, asks the agent to run the commands the role needs and some that must be refused, and prints `PASS`, `FAIL` or `NOT ATTEMPTED` (a command the agent never tried) for each. It uses `haiku` by default (`--model` for another). Same guarantees as the probe: its own throw-away Claude configuration folder, deleted at the end with its credentials unless `--keep`; a dry run against the fake `claude` in CI; and no personal data in its output or in any file it records (the probe's sanitising and final guard);
- allowlist rules use Claude Code's documented syntax: `Bash(pnpm test *)` (the older `Bash(pnpm test:*)` is equivalent), MCP tools as `mcp__orchestrator__<tool name>` (06, section 3);
- every allowlist includes `ToolSearch`, which Claude Code needs to load MCP tools.

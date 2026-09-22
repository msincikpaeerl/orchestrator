# 00 — Vision and Scope

> Status: Draft v0.1
> Owner: project owner (single user)
> Related: [01 — Domain Model](01-domain-model.md), [04 — Ticket Lifecycle](04-ticket-lifecycle.md)

## 1. Purpose

The Orchestrator is a self-hosted tool that turns plain-language requests into working software (web apps, websites, Android apps) by coordinating a team of AI agents running in Claude Code.

The owner describes what they want. A Project Manager agent turns it into a plan made of tickets. Specialised agents implement the tickets on the owner's machines. Every change goes through tests, review and documentation before it reaches the main branch. The owner stays in control of what gets built and what gets merged.

## 2. Target user

A single technical owner who:

- wants to build personal and side projects without writing most of the code;
- must be able to use the tool **without reading its source code**: everything needed is in the user documentation;
- runs Claude Code on a **Claude Pro subscription shared with personal use**, so AI capacity is scarce and must be spent carefully.

## 3. Core principles

These principles settle design disputes. When two options conflict, the one that better respects these principles wins.

1. **The human decides, the agents execute.** The owner approves plans and merges pull requests. Agents never merge into the main branch in v1.
2. **The harness is the product.** Every project, including the Orchestrator itself, is built on a harness of documentation, tests, CI and recorded technical decisions. The system enforces it; it is not optional guidance.
3. **LLMs decide, code schedules.** Agents choose *what* to do (split work, assign, comment). Deterministic server code decides *when and where* work runs.
4. **Quota is the scarcest resource.** Scheduling, prompts and context size are designed around a limited, shared Claude Pro quota.
5. **No screen scraping.** Claude Code runs in interactive mode, but state is never read from the terminal display. It is read from hooks, session transcripts and MCP calls.
6. **Replaceable engines.** The agent runtime sits behind a runner abstraction and a standard MCP interface, so other CLIs and LLMs can be added later without redesign.
7. **Documented for the user.** Every user-facing feature ships with its user documentation in the same change.

## 4. System overview

The system has two parts.

**Web application (control plane)**, shipped as Docker containers:

- project management, each project linked to a GitHub repository;
- agent profiles (defaults and custom);
- tickets, comments and plans;
- request inbox, where the owner talks to the Project Manager agent;
- machine and Claude account management;
- scheduler;
- MCP backend used by agents to read and update tickets;
- in-app user documentation.

**Daemon (execution plane)**, installed on each machine that runs Claude Code (Linux or Windows via WSL):

- opens an outbound connection to the web application;
- clones repositories and manages one Git worktree per run;
- starts Claude Code in interactive mode inside a tmux session and sends it instructions;
- collects state from Claude Code hooks and session transcripts;
- exposes a local MCP server to Claude Code and relays calls to the web application.

## 5. Scope of v1

### In scope

- Single user, single Claude account (Pro).
- One or more machines, with **one run at a time per Claude account**.
- Project creation with automatic GitHub repository creation from a project template (see 08 — Harness).
- Request inbox and Project Manager agent producing a plan that the owner approves or rejects.
- Six default agents: Project Manager, Architect, Web Developer, Android Developer, Quality, Technical Writer. Custom agents can be created from the UI.
- Tickets with types, dependencies, acceptance criteria, comments and the lifecycle defined in 04.
- One branch and one pull request per ticket. Merge is done by the owner on GitHub.
- Definition of Done checks enforced by the system.
- Agent questions to the owner, pausing the ticket until answered.
- Live run logs in the UI, streamed from session transcripts.
- Quota handling: time windows, manual pause, automatic pause when the usage limit is reached.
- Android projects: build and unit tests in CI, APK as a build artefact.
- In-app user documentation.
- All documentation, UI text and agent prompts in English.

### Out of scope for v1

- Multiple users, roles and permissions between humans.
- Deploying generated projects (hosting websites, publishing apps to stores).
- Android emulator or on-device tests.
- Automatic merge by agents.
- Non-Claude runners (the abstraction exists, no second implementation).
- Headless Claude Code (`claude -p`) and API-key billing.
- Native Windows or macOS daemons (Windows is supported through WSL only).
- Public exposure of the web application on the internet.

## 6. Constraints

| Constraint | Consequence |
|---|---|
| Claude Pro subscription shared with personal use | One run at a time per account, time windows, automatic pause on limit, Sonnet by default, small focused tickets. |
| Interactive Claude Code only | Daemon drives tmux; state comes from hooks, transcripts and MCP. |
| Runs first on WSL, later on a VPS or a home server | Web app is fully containerised (Docker Compose). Daemon connects outbound; no inbound port needed on dev machines. |
| No public endpoint in v1 | GitHub state (PR merged, CI status) is read by polling, not webhooks. |
| Owner does not read the code | User documentation is a deliverable of every feature. |

## 7. Success criteria for v1

v1 is successful when the owner can, using only the UI and the user documentation:

1. connect a machine and a Claude account;
2. submit a request such as "a simple website with a contact form";
3. review and approve the plan proposed by the Project Manager;
4. watch agents work, answer their questions, and read their progress on tickets;
5. merge the resulting pull requests on GitHub;
6. end up with a repository that has passing CI, tests, a README, user documentation and recorded technical decisions;
7. leave the system running overnight within a configured time window without it failing repeatedly when the quota runs out.

## 8. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Anthropic changes how interactive or programmatic usage is billed | Runner approach may need to change | Runner abstraction; a headless runner can be added without touching the rest. |
| Claude Code interactive behaviour changes between versions | Daemon may stop driving sessions correctly | Rely on documented hooks and transcripts only; daemon checks the Claude Code version and reports unsupported ones. |
| Pro quota too small for useful throughput | Slow progress | Time windows, small tickets, lean context, Sonnet by default, clear quota visibility in the UI. |
| Agents produce low-quality or unreviewed work | Broken projects | Enforced Definition of Done, Quality agent review, human merge. |
| Runaway planning (too many tickets) | Quota waste | Plan approval by the owner; limits on tickets per plan. |
| WSL shuts down when idle | Daemon goes offline | Daemon runs as a systemd service; the user documentation explains how to keep WSL running. |

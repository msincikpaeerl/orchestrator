# Lot 2 — Implementation plan

> Status: in progress (version 0.3.0)
> Scope: "Lot 2 — Machines and manual runs" in [10 — Delivery Plan](../specs/10-delivery-plan.md).
> **Lot 2 is done when** the owner starts a run on a ticket, watches it live, answers a question, and finds the agent's commits on a local branch.

Every session follows the [working rules](working-rules.md). Branches: `lot2/<step letter>-<short-name>`. Steps are done one after the other, in the order below. No session starts a real Claude Code session (rule 10): the daemon is tested with real tmux and a fake `claude` executable, and the real Claude Code is used only by the owner, in steps H and N.

## Decisions taken for this lot (2026-09-24)

Confirmed by the owner in step A and written into the specs:

- **Tickets created by agents** (`ticket.create`) are `proposed`, with no plan. The owner can **Accept** them (`proposed` → `todo`) or **Reject** them (`proposed` → `cancelled`, with an optional comment). The board shows a "Proposed" column whenever one exists, and "Needs you" lists them (01 section 3.3, 02 sections 4 and 6.3, 04 sections 1 and 2, 06 section 4.3).
- **Usage limits** (05 section 4.10, 07 section 5.2):
  - Detection lives in one daemon module, driven by a table of patterns with fixtures.
  - A **detected** limit pauses the run (`paused_quota`, reason `usage_limit`) and makes the account `limited` until the reset time, or now plus `quotaFallbackDelayMinutes`. **Resume** is refused until then.
  - A **suspected** limit is an API-error turn with no tool use, or an idle timeout right after one. It pauses the run with the reason "suspected usage limit", leaves the account unchanged and allows **Resume** at once: overload or network errors never lock the account.
  - Neither sends nudges or counts as an attempt.
  - The fake `claude` emits every signal.
  - `--scan-limit` is extended and a `--probe-limit` mode is added. If the real signal is not captured before the lot check, the capture moves to lot 4.
- **How a run ends** (04 sections 1 and 3.1, 06 section 4.2):
  - In lot 2, a reduced `ticket.submit` takes the full input. It checks only that every criterion is `met`, the worktree is clean, and the branch has commits ahead of the base branch.
  - When the checks pass, the report is stored, the run ends `succeeded` and the ticket moves to `in_review`. In lot 2, `in_review` means "work finished, owner checks it"; no Quality run exists before lot 3.
- **Setup wizard**: steps 3 and 4 stay in lot 5 (spec 10). "Needs you" shows "No Claude account yet" and "No machine connected yet" (02 section 3).
- **Run now** is the only way a run starts until the scheduler exists (lot 4). It checks eligibility and the account (not limited, below its maximum concurrent runs), picks the machine automatically (07 section 4), and shows the reason when it refuses (04 section 2, 07 section 3).
- **Answer after the waiting run lifetime**: the same run resumes on the same machine at once. If that machine is offline, the run fails with `machine_offline` and the ticket returns to `todo` (04 sections 2 and 6).
- **Stop run** by the owner: the run is `cancelled`, the ticket returns to `todo`, a `status_change` comment is written, and the branch is kept (04 section 2).
- **Attempts are never counted** for an owner's Stop run, a `machine_offline` failure or a dispatch not acknowledged in time (01 sections 3.4 and 3.7, 04 section 5).
- **Git credentials** (01 section 4, 05 sections 3.3 and 7):
  - `git.credential_request` / `git.credential` cover one command (`fetch`, and `push` from lot 3). Hard constraints:
    - the credential helper is passed only on the command's line (`git -c credential.helper=…`), never written to any Git configuration;
    - remote URLs never contain a token;
    - the token lives only in the daemon's memory for that command;
    - a test proves that a `git fetch` run in the worktree outside the daemon has no credentials.
  - Tests use a local remote whose clone URL comes in `run.start`.
- **The local branch**: at run end the daemon reports the branch head and the commits ahead of base. The ticket page shows them "on machine X, not on GitHub yet", and `orchestrator-daemon status` lists local branches (01 section 3.4, 02 section 6.4).
- **Commit author**: "<profile name> (Orchestrator)" with the owner's GitHub noreply address. The id and login are read and stored when the token is saved, not at every run (02 section 3.2, 04 section 4).
- **Claude Code versions**: minimum 2.1.280, refused below. A version above the highest validated one gets a warning. The auto-updater stays on (05 section 2).
- **Realtime**: one Server-Sent Events stream per logged-in browser carries "changed" messages and log lines. Screens also reload on reconnection and on focus. The project setup polling and `projectSetupPollSeconds` are removed (02 section 1, 04 section 8, 09 section 4).
- **Daemon installation**: the server serves a single-file bundle of its own version, installed with `npm install -g <server URL>/downloads/orchestrator-daemon-<version>.tgz`, with an ADR (05 section 2, 02 section 9.2).
- **Linux user**: in lot 2 the daemon runs under the owner's user. `PreToolUse` deny rules (and settings deny rules) cover `~/.orchestrator/` (machine token included) and the Claude configuration folders, each with a test. The user documentation states plainly that an agent is less isolated this way and that Bash path checks are best effort (05 sections 2 and 4.6).
- **Capabilities**: the daemon detects some (`git`, `node`, `docker`) and the owner edits them. The project's `required_capabilities` comes with lot 6 (01 section 3.8).
- **Offline machine and daemon restart** (05 section 6, lot 2 subset):
  - `runs/<id>/state.json` lets a restarted daemon find its sessions;
  - a run the server no longer considers active is stopped at reconnection;
  - while offline, runs show "machine offline", and Stop run fails them with `machine_offline`.
- **Logs** (02 section 7):
  - one stored entry per transcript event, tool results cut to "Longest stored log entry";
  - credentials masked with the event log's patterns;
  - the estimated usage is shown per run;
  - logs are kept as long as the run.
- **MCP tool names** on the wire are `<object>_<verb>`, seen by agents as `mcp__orchestrator__ticket_create` (06 section 3).
- **`ticket.create` input**: the fields of the owner's form, with optional `blocked_by` and assignee. The refusals are listed in 06 section 4.3.
- **Profiles**: only `architect` and `web_dev` are seeded. They are not editable before lot 6, and their version goes up when a shipped file changes. Any existing profile can be assigned (01 section 3.6, 03 sections 3.1 and 6).
- **Settings** (04 section 8, all global, all read through `resolveSettings`):

  | Setting | Default | Range |
  |---|---|---|
  | Enrollment code lifetime | 15 minutes | 1 to 1,440 minutes |
  | Heartbeat interval | 15 seconds | 5 to 120 seconds |
  | Machine offline after | 60 seconds | 15 to 600 seconds |
  | Session start timeout | 30 seconds | 5 to 600 seconds |
  | Progress update interval | 60 seconds | 0 to 3,600 seconds |
  | MCP call timeout | 30 seconds | 5 to 300 seconds |
  | Claude Code MCP tool timeout | 120 seconds | 10 to 1,800 seconds |
  | Longest stored log entry | 2,000 characters | 100 to 100,000 characters |

  - Cross-setting rules, refused with a message naming both settings: "Machine offline after" is at least twice the heartbeat interval; the MCP call timeout is below the Claude Code MCP tool timeout, which the daemon writes into `mcp.json`.
  - The reconnection backoff (1 to 60 s) is a daemon constant, with the reason given in 05 section 3.2.
  - Checked in the code: `maxAgentTicketsPerRun`, `waitingRunLifetimeMinutes`, `maxRunDurationMinutes`, `idleTimeoutMinutes`, `maxNudgesPerRun` and `dispatchAckTimeoutSeconds` are already marked "used from 0.3.0" in `packages/protocol/src/api/settings.ts`.
  - `quotaFallbackDelayMinutes` moves from 0.5.0 to 0.3.0 in step J (its longest-delay partner stays 0.5.0).
  - Display constants in `packages/protocol`: log entries per page, progress line length on cards.
- **Working rules**: rule 10 added (no real Claude Code session; tests use the fake `claude`). Summary and pull request text become rules 11 and 12, and CLAUDE.md's reference is updated.
- **Small corrections**: Claude Code's native installer needs no Node.js, so Node.js is a daemon prerequisite (05 section 2). The daemon states map to run statuses (05 section 4.7). `ci.status` is lot 3 and `request.get` lot 5 (06 section 4.1).

**Host prerequisites** (working rule 8; the owner installs them, sessions never do):

| Tool | Check | Needed |
|---|---|---|
| Node.js | `node --version` | 24.x (daemon runtime; development uses `.nvmrc`) |
| Git | `git --version` | 2.40 or later |
| tmux | `tmux -V` | 3.2 or later; also for `pnpm test` from step F. In CI it comes from apt (not pinnable): CI prints `tmux -V`, and `docs/dev/setup.md` states the minimum |
| Claude Code | `claude --version` | 2.1.280 or later (owner's machine only; never used by sessions) |
| systemd (WSL) | `systemctl --user is-system-running` | `running`, with `[boot] systemd=true` in `/etc/wsl.conf` |
| WSL kept running | — | `instanceIdleTimeout=-1` under `[general]` in `%UserProfile%\.wslconfig`, or a WSL window left open |

Found on the owner's WSL on 2026-09-24: Ubuntu 26.04, tmux 3.6, Git 2.53.0, Node.js 24.21.0, Claude Code 2.1.282 (native installer), systemd `running`.

## Notes: documentation check (2026-09-24)

These notes come from Claude Code's official documentation (code.claude.com, pages for hooks, permissions, settings, CLI reference, environment variables, MCP, status line, sessions, errors, interactive mode and the changelog, as of version 2.1.282, released 2026-09-24), from Microsoft's WSL documentation, and from ADR 0002. Nothing was run on the real Claude Code. ADR 0002 gained a dated update.

Current version: 2.1.282. The changelog entries for 2.1.281 and 2.1.282 change nothing the daemon relies on. One fix concerns multi-line pastes after bracketed paste mode was reset (05 section 4.4, no change needed).

Hooks (05 section 4.5):

- The `SessionStart` input has `source` (`startup`, `resume`, `clear`, `compact`, `fork`) and optional `model`, as the spike found. `Stop` has `last_assistant_message`. `Notification` has `notification_type` (`idle_prompt` about 60 seconds after a turn).
- **`StopFailure`** runs *instead of* `Stop` when a turn ends on an API error. Its `error` field is one of: `rate_limit`, `overloaded`, `authentication_failed`, `oauth_org_not_allowed`, `account_on_hold`, `billing_error`, `invalid_request`, `model_not_found`, `server_error`, `max_output_tokens`, `cloud_credential_error`, `unknown`. It also has optional `error_details`, and `last_assistant_message` holding the error text. Its output is ignored. **This changes Q2** for the better: the daemon gets a structured hook for API errors, and the nudge logic must treat `StopFailure` as "no nudge".
- `PreToolUse` denies with `{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "…"}}`. Exit code 2 also blocks, before permission rules are evaluated. A hook's "allow" never overrides a deny rule. The default hook timeout is 600 seconds.

Usage limits (05 section 4.10, **changes Q2**):

- Documented messages: `You've hit your session limit · resets 3:45pm`, and the same with `weekly limit · resets Mon 12:00am`, `Opus limit` and `Sonnet limit`. The reset is a local wall-clock time, sometimes with a weekday, so parsing it needs the machine's time zone.
- The **status line command** receives JSON with `rate_limits.five_hour` and `rate_limits.seven_day` (`used_percentage`, `resets_at` in Unix seconds, for Pro and Max, after the first API response) and `cost.total_cost_usd`. It is declared in settings like a hook and needs workspace trust like hooks. It runs on events (debounced 300 ms), plus `refreshInterval` if set.
  - The daemon registers a status line command as a **supplementary** source: `resets_at` gives the reset time, and `cost.total_cost_usd` the run's estimated usage, with the transcript's `cost-state` as fallback. It runs only when the interface refreshes, so detection never depends on it alone (owner's review).
- Claude Code has its own **automatic continue** after a usage limit (`autoContinueAtUsageLimit`, default `true`, read from `--settings`). Runs set it to `false` so only the Orchestrator resumes work. With it off, Claude Code may show its usage-limit options menu in the terminal. That doesn't matter, because the daemon closes the session on a limit.
- `Notification` types `quota_auto_resume_*` exist (only with automatic continue, so not used).
- A `rate_limit` error can also be a server throttle ("Server is temporarily limiting requests"), unrelated to the plan quota. So `rate_limit` alone is only **suspected**. It is **detected** with a known usage-limit message, or a `rate_limit` failure while a status line window shows 100 %.
- `--scan-limit` only reads `~/.claude/projects`. Step M extends it to `~/.orchestrator/claude-config/projects` and prints whole lines. `--probe-limit` logs every hook and the status line input of one session run while limited, which uses no quota.

Transcript (05 section 4.5): the location `<config>/projects/<path with non-alphanumerics replaced by ->/<session id>.jsonl` is documented. The format is documented as **internal and changing between versions**. The daemon reads it tolerantly and only for the live log.

Permissions and settings (05 sections 4.3 and 4.6, **changes Q14**):

- `dontAsk` automatically refuses anything that would prompt. File reads outside the working directories prompt, so they are refused.
- Rules are evaluated deny, then ask, then allow; the first match wins. `Bash(cmd *)` is the documented form, and `Bash(cmd:*)` is equivalent at the end of a pattern. Compound commands must match rule by rule for each subcommand (`&&`, `||`, `;`, `|`, `&`, newlines), and redirections are checked against the file rules.
- Read and Edit deny rules with `//absolute/path/**` apply to the file tools, to file commands Claude Code recognises in Bash (`cat`, `head`, `tail`, `sed`, `tee`) and to redirect targets. They don't apply to programs that open files indirectly. So the deny rules for `~/.orchestrator/` and the configuration folders go both in the run's `settings.json` and in the `PreToolUse` hook.
- **Settings precedence**: managed, then command line (`--settings`), local, project, user, with **lists merged across sources** (`permissions.allow`, hooks). The repository's `.claude/settings.json` could therefore widen a run's allowlist or add hooks once the workspace is trusted. Decision written into 05 section 4.3: runs pass `--setting-sources user`. Its consequence: project `CLAUDE.md` and `.claude/rules/` are not loaded either (documented for the SDK's `settingSources`, where `project` is what loads CLAUDE.md). So the common rules tell the agent to read `CLAUDE.md` first (03 section 3, 06 section 6). Confirmed by the owner (see "Owner's answers" below).
- `--strict-mcp-config` makes Claude Code use only `--mcp-config` servers (the repository's `.mcp.json` is ignored); it's documented since v2.1.246 not to wait for project server approvals.
- `CLAUDE_CONFIG_DIR` is documented (settings, history, plugins); the permissions page says user settings are `$CLAUDE_CONFIG_DIR/settings.json` when it is set. So with `--setting-sources user` the only settings file a run reads is the daemon's own `~/.orchestrator/claude-config/settings.json`, never the owner's `~/.claude/` (05 section 4.3). Managed settings (`/etc/claude-code/`, and on WSL optionally the Windows policy) always load, whatever the sources; `doctor` reports any. `DISABLE_AUTOUPDATER=1` exists but is not used (owner's decision on versions).
- Workspace trust: in a repository, trust is keyed on the repository root; in a worktree, on the main checkout's root. This matches ADR 0002.

MCP (06 sections 1 and 3, **confirms Q18**):

- Tool names shown to Claude are `mcp__<server>__<tool>`. Characters outside `A-Z a-z 0-9 _ -` are replaced with `_` (documented for plugin servers). `<object>_<verb>` wire names avoid relying on that replacement.
- `MCP_TOOL_TIMEOUT` defaults to about 28 hours. A per-server `timeout` (milliseconds) in the MCP configuration overrides it, and the daemon writes it from the "Claude Code MCP tool timeout" setting. Stdio servers have no per-request timer and a 30-minute idle window by default. `MCP_TIMEOUT` (server start, 30 seconds by default) is fine for a local relay.
- Tool output is limited to 25,000 tokens (`MAX_MCP_OUTPUT_TOKENS`): `ticket.list` and `ticket.comments` must page or summarise.

CLI (05 section 4.3):

- `--append-system-prompt-file` is documented and said to work in interactive mode. **This contradicts ADR 0002**; the owner chose to keep the text form.
- `--session-id <uuid>` exists. It could give the daemon the session id before `SessionStart`, but it isn't adopted, since the spike's `SessionStart` path works.
- `--resume` accepts an id or a transcript path.

WSL (05 section 2): systemd is enabled with `[boot] systemd=true` in `/etc/wsl.conf` (WSL 0.67.6 or later), then `wsl.exe --shutdown`. Microsoft states that **systemd services do not keep a WSL instance alive**. `.wslconfig` `[general] instanceIdleTimeout` (default 15,000 ms, `-1` disables the automatic shutdown of a distribution) keeps it running. The user documentation (step D, Add machine help) gives both, with `loginctl enable-linger` for the user service. The daemon cannot read the Windows `.wslconfig`, so `doctor` prints `instanceIdleTimeout` as "check this yourself" with the documentation link.

**Owner's answers on the open points** (review of step A, 2026-09-25):

1. `--setting-sources user`, with the agent reading `CLAUDE.md` itself: accepted. 05 section 4.3 states that the "user" source is the daemon's own `settings.json` in its `CLAUDE_CONFIG_DIR`, written only by the daemon, covered by the deny rules; the owner's `~/.claude` settings never reach a run.
2. System prompt passed as text: accepted.
3. The documentation-only behaviour is checked early, by the owner, in step H (right after the permission step G, before any run code depends on it), with `tools/smoke/claude-code-probe.sh`. `StopFailure` and the usage-limit data stay with the capture (`--probe-limit`), since they cannot be triggered on demand. Step N keeps the full allowlist smoke test.
4. The status line is a supplementary source of the reset time and the usage estimate; detection never depends on it alone (05 section 4.10).
5. `instanceIdleTimeout=-1` is in the Add machine help page, and `doctor` prints it as "check this yourself" with the documentation link (05 sections 2 and 8).

## Steps

### [x] A. Plan and spec decisions

- Working rule 10 added. Rules 11 and 12 renumbered, and CLAUDE.md's reference and "Current state" updated.
- Specs 01, 02, 03, 04, 05, 06, 07, 09 and 10 updated with the decisions above. ADR 0002 has a dated update. `docs/dev/setup.md` lists Git and tmux minimums.
- Documentation check (notes above).
- This plan.

**Done when** the owner has approved this plan and the spec changes.

*Done 2026-09-25.* Approved by the owner with the review changes: step H probe, status line as a supplementary source, daemon-owned user settings, WSL idle timeout in help and doctor.

### [x] B. Daemon protocol and MCP schemas

- `packages/protocol/src/daemon/`: Zod schemas for every message of 05 section 3.3:
  - `hello`, `welcome`, `heartbeat`;
  - `run.start` (payload of 05 section 4.1), `run.input`, `run.resume`, `run.stop`, `run.state` (with branch head and commits), `run.events`, `run.quota_limited` (`detected` or `suspected`, reset time, evidence);
  - `mcp.call`, `mcp.result`, `git.credential_request`, `git.credential`;
  - the acknowledgement envelope `{ type, id, payload }`.
- Protocol version 1, returned by `/version`.
- `packages/protocol/src/mcp/`: input and output schemas for the lot 2 tools (`project_get`, `ticket_get`, `ticket_list`, `ticket_comments`, `agent_list`, `ticket_progress`, `ticket_comment`, `ticket_ask`, `ticket_give_up`, `ticket_create`, `ticket_submit`), and the error codes of 06 section 3. Tool descriptions are written for the agent (06 section 3).
- Hook, status line and fake-`claude` scenario schemas go in step F, which uses them.

**Done when** unit tests accept a valid example of every message and tool and reject invalid ones (missing field, wrong type, unknown type, oversized text), and `/version` reports protocol 1 (server test).

*Done 2026-09-25.* Owner's decisions, written into 05 sections 3.3 and 4.9 and 06 section 3:

- the heartbeat carries nothing else in lot 2; lot 4 adds the resource summary as an optional field;
- text ceilings are derived from the settings' declared ranges (`text-limits.ts`), never copied numbers;
- for `ticket_submit`, the daemon sends the worktree facts (clean, branch head, commits ahead) collected when it forwards the call, and the server runs every check;
- `ack` answers the server's commands and the daemon's reports (`run.events` per batch). Unacknowledged reports are kept in the run files and resent in order after reconnection, and duplicates are handled idempotently by message id; that behaviour is tested in the steps that implement it (E, F, J).

Owner's review of the tool descriptions (same day), written into 04 section 8 and 06 sections 3 and 4:

- `ticket_progress` is never refused for frequency: the server keeps the latest line and publishes it at most once per "Progress update interval";
- the `ticket_submit`, `ticket_create` and `ticket_give_up` descriptions say what to do instead (report every criterion, paths relative to the worktree root, never push or switch branches, `ticket_ask` or `ticket_give_up` rather than submitting an unmet criterion, search before creating, never give up over a refused command or an unanswered question);
- every refusal tied to a setting states the setting's current value in its message; the steps implementing refusals (C, J, K) test it;
- every text sent to an agent comes from a run message template in `agents/` (03 section 3.2, 05 sections 3.3, 4.1 and 4.8): the first message, the "please continue" message after a pause, the wrapping of the owner's answer, and the nudge, which the server fills in and sends in `run.start`; the daemon decides when to nudge but holds no agent-facing text. Step I ships the four templates.

### [x] C. Claude accounts, machines and the daemon gateway (server)

- Migration: tables `claude_accounts` (label, plan, `max_concurrent_runs`, `state`, `limited_until`) and `machines` (01 section 3.8: name, account, OS, capabilities detected and edited, versions, status, last heartbeat, token hash, `doctor` results).
- Enrollment codes (hashed, single use, "Enrollment code lifetime" setting) and machine tokens (hashed, revocable).
- Stored GitHub account id with the token: read when the token is saved, or at the next check for a token saved before 0.3.0 (02 section 3.2). This is the only GitHub change of the step.
- WebSocket endpoint (`/daemon`):
  - token authentication, `hello`/`welcome` with the protocol check (current and previous version accepted);
  - heartbeats and offline detection ("Heartbeat interval", "Machine offline after");
  - revocation disconnects the daemon;
  - the Claude Code version check: below the minimum (or missing), or a `doctor` error, the machine is connected but unusable; above the highest validated version, a warning only (05 section 3.2).
- Settings: the three new ones, and the cross-setting rule extended from "never above" to "at least twice" (heartbeat and offline) and "strictly below" (for step G's MCP pair), with messages naming both settings.
- API with protocol schemas: accounts (create, edit, list), machines (create with enrollment code, list, detail, disable, revoke, edit capabilities).
- Events for every change (`machine.enrolled`, `machine.online`, `machine.offline`, `machine.revoked`, `account.created`, …), each with a plain-words text in the event log (as in lot 1 step I).
- "Needs you" API: no account, no machine, machine offline with active work (active work comes in step J), daemon incompatible, Claude Code unsupported.
- ADR: WebSocket library for the server and the daemon.

**Done when** integration tests with a scripted WebSocket client cover:

- enrolment;
- an expired, a reused and an unknown code;
- a bad and a revoked token (disconnected);
- an incompatible protocol;
- a Claude Code version below minimum and above validated;
- offline after the configured silence;
- each cross-setting refusal;
- the stored GitHub id (fake GitHub);
- every new event type having a plain-words text.

*Done 2026-09-25.* Owner's decisions, written into 01 sections 3.7 to 3.9, 02 sections 4 and 9.2, 04 section 5, 05 sections 3.1 and 3.2, and 09 section 6:

- enrollment is `POST /daemon/enroll` with `{ code }`, answered with the machine token once; the code is 24 characters of Crockford's Base32 (120 bits), single use (marked used in the transaction that sets the token), and wrong codes are throttled per address with the login throttling and its settings, under their own key;
- a machine's `status` is only `online` or `offline`; enrolled, disabled and revoked are separate fields, and screens show one label in the order revoked, waiting for enrollment, disabled, online, offline; disabling lets active runs finish, revoking fails them with `machine_revoked` (not counted, step J);
- **New enrollment code** is offered on a machine waiting for enrollment or revoked; on a revoked machine it goes back to waiting, and earlier tokens are never valid again;
- capabilities are detected, added and removed lists; the machine page shows each tag's source;
- a Claude Code missing or below the minimum, or a `doctor` error, leaves the machine connected but unusable ("Needs you"); warnings are shown only on the machine page; an incompatible protocol is still refused at `welcome`;
- a machine is offline when its connection closes or after "Machine offline after" of silence (never below twice the heartbeat interval it was given); a newer connection replaces an older one without going offline; going offline never ends a run in lot 2;
- `max_concurrent_runs` is 1 to 10; account labels and machine names are 1 to 80 characters, unique without regard to case;
- "No machine connected yet" shows while no machine is enrolled and not revoked.

Choices within the step: WebSocket library in ADR 0025; the Claude Code minimum and highest validated version (2.1.280 and 2.1.282) are constants in `packages/protocol`, shared with the daemon; an unknown token is refused with HTTP 401 before the WebSocket opens, a revoked one gets `welcome` refused with `token_revoked` (its hash is kept until a new code); the server's close codes are in `DaemonCloseCode`; a connection without `hello` within "Machine offline after" is closed; machine tokens start with `omt_`; refusals tied to a setting carry `setting` (name and current value) in the error body; the "Needs you" page shows only project items until step D; the Claude Code and `doctor` checks run at each `hello`; daemon messages other than `hello` and `heartbeat` are logged and ignored until step J. The GitHub account id is read at the save and at each check; its "first use" (02, section 3.2) is the first run, in step J.

### [ ] D. Accounts and machines screens, user documentation

- Machines section (02 section 9):
  - accounts: list and form (label, plan, maximum concurrent runs), state;
  - machine list and detail: status, versions (with the "above validated" warning), capabilities editor, `doctor` results, disable, revoke with confirmation;
  - **Add machine**: the two commands, then `login` and `install-service`, then waits for the connection (without the stream yet, it refreshes on focus and after actions; step L makes it live).
- "Needs you" items from step C.
- `docs/user/`: a Machines page covering:
  - prerequisites with version checks;
  - WSL systemd and keeping WSL running (`instanceIdleTimeout=-1` in the Windows `.wslconfig`, explained on the Add machine help page);
  - installing the daemon;
  - enrolment, `login`, the service;
  - `doctor`;
  - revoking;
  - the plain warning that agents under the owner's user are less isolated and that Bash path checks are best effort.
- Getting started and needs-you pages updated; Settings reference updated.
- Playwright on both viewports, with the scripted daemon client from step C as a test helper.

**Done when** Playwright covers creating an account, adding a machine until the scripted daemon connects, editing capabilities, and revoking it, on both viewports.

### [ ] E. Daemon core

- `apps/daemon`:
  - CLI with `enroll`, `start`, `status`, `doctor`, `install-service`, `login` (starts Claude Code with the dedicated `CLAUDE_CONFIG_DIR` for the owner; never started by tests with the real `claude`), `attach`;
  - `~/.orchestrator/config.json` with mode `600` (the home folder is configurable for tests: tests never touch the real home);
  - connection with backoff constants, heartbeat, `hello` with the detected capabilities and the `doctor` results;
  - `install-service`: systemd user unit `orchestrator-daemon`, with the absolute paths of `node` and of the daemon's script written into it (05 section 2, owner's decision in step D).
- `doctor`: `git`, `tmux`, `claude` with versions against the minimums, systemd user session, lingering, the unit's `node` path (an error when it no longer exists or differs from the `node` running the daemon), managed Claude Code settings found, WSL detection. What it cannot read (the Windows `.wslconfig` `instanceIdleTimeout`) it prints as "check this yourself" with the documentation link (`<server URL>/help/machines#keep-wsl-running`, the section written in step D).
- Packaging: the daemon bundled into one file. The server builds the `.tgz` and serves it at `/downloads/orchestrator-daemon-<version>.tgz`. ADR: daemon packaging and bundler.
- `docs/dev/architecture.md` updated.

**Done when** daemon tests against the real server from step C cover enrol, connect, reconnect after a server restart, and revocation. `doctor` is tested with fake `git`/`tmux`/`claude` executables reporting missing, old and new versions. A test installs the served package into a temporary prefix and runs `orchestrator-daemon --version`.

### [ ] F. Fake `claude`, workspace and tmux runner

- **Fake `claude`** (`apps/daemon/test/fake-claude/`), an executable driven by a scenario file:
  - reads its arguments (and checks the argument order of 05 section 4.3);
  - runs the hook commands of the given `settings.json` with realistic JSON (`SessionStart`, `PreToolUse`, `PostToolUse`, `Stop`, `StopFailure`, `Notification`, `SessionEnd`) and the status line command;
  - writes transcript lines;
  - starts the MCP server of `mcp.json` and calls tools;
  - reads pasted input from the terminal;
  - makes commits in the worktree;
  - emits each configurable usage-limit signal (05 section 4.10).

  ADR: testing the daemon with real tmux and a fake `claude`.
- **Workspace**:
  - bare clone and fetch with the per-command credential helper (the daemon side of `git.credential`; the token is taken from a test source here, and the server side comes in step J);
  - atomic trust entry;
  - worktree on the existing or a new branch, commit author per worktree;
  - run files, `state.json`.
- **Runner**:
  - tmux session `orch-<run-id>` with the argument list (including `--strict-mcp-config`, `--setting-sources user`, `autoContinueAtUsageLimit: false`);
  - input through `load-buffer`/`paste-buffer -p` when idle, queued otherwise;
  - the hook socket and the daemon state machine (05 section 4.7);
  - nudges (never after `StopFailure`), idle timeout, maximum duration, session start timeout (new setting);
  - the version of the `claude` launched, reported at each run start (05 section 4.3; the server's check comes in step J);
  - end of run with branch head and commits;
  - cleanup (worktree removed, branch kept in the bare clone);
  - recovery from `state.json` after a daemon restart.
- CI: install tmux from apt and print `tmux -V`.

**Done when** daemon tests with real tmux and the fake `claude` cover:

- start to `SessionStart`, and the session start timeout;
- an idle turn nudged twice, then ended;
- maximum duration;
- a three-line input arriving as one message;
- the worktree removed with the branch and commits kept;
- the trust entry written atomically (concurrent writers);
- a daemon restart finding a live session.

The credential tests use a local authenticated Git HTTP remote (`git http-backend` behind a test server):

- fetch works through the daemon;
- no Git configuration file of the bare clone or worktree contains a helper or token;
- no remote URL holds a token;
- a `git fetch` run in the worktree outside the daemon fails for lack of credentials.

### [ ] G. Permission enforcement, MCP relay and usage-limit detection

- **`PreToolUse` rules** (05 section 4.6), each with its reason:
  - `git push` and any command reaching GitHub;
  - changes to `.claude/`;
  - the daemon's folder `~/.orchestrator/` (machine token) and the Claude configuration folders;
  - other paths outside the worktree and run folder, exact for file tools and best effort for Bash.
- Settings deny rules for the same folders in the run's `settings.json`.
- **MCP relay**: `orchestrator-daemon mcp --run <id>` (stdio, wire names of 06 section 3), forwarding through `daemon.sock` and `mcp.call`/`mcp.result`; `UNAVAILABLE` after the MCP call timeout or while disconnected. `mcp.json` carries the Claude Code MCP tool timeout. New settings "MCP call timeout" and "Claude Code MCP tool timeout" with their cross-setting rule. ADR: MCP SDK.
- **Usage-limit module** (05 section 4.10) with its pattern table and fixtures from the documentation; the status line collector (reset time and `cost.total_cost_usd`); `run.quota_limited` and closing the session.
- **Profile settings generation**: allowlist and deny rules from a profile snapshot (`ToolSearch` always allowed).

**Done when** fake `claude` tests show:

- every deny rule refusing with its reason, and allowed calls passing, including a Bash `cat ~/.orchestrator/config.json` and a file-tool read of the Claude configuration refused;
- a tool call relayed end to end to a scripted server, and `UNAVAILABLE` on timeout and on disconnection;
- `detected` for the documented messages (with the status line reset time, with the message time, and with neither);
- `suspected` for a `rate_limit` without a known message, an `overloaded` and a `server_error` `StopFailure`, an API-error turn with no tool use, and an idle timeout right after one;
- no nudge in any of these cases;
- the estimated usage read from the status line.

### [ ] H. Owner check of documented Claude Code behaviour

The lot's security and quota design relies on behaviour read in the documentation but never run (notes above). The owner checks it now, before any run code depends on it (owner's review of step A).

- `tools/smoke/claude-code-probe.sh`, for the owner only (working rule 10). It creates a scratch folder outside the repository (under the owner's temporary folder, printed at the start), with:
  - a dedicated `CLAUDE_CONFIG_DIR`, logged in the same way as `orchestrator-daemon login`;
  - a test repository whose `.claude/settings.json` allows a marker command and declares a hook writing a marker file, and whose `.mcp.json` declares a marker MCP server;
  - a denied folder holding a marker file.

  It starts **one** session with the daemon's argument list and settings generation from step G (`--setting-sources user`, `--strict-mcp-config`, deny rules, status line command, `autoContinueAtUsageLimit: false`), and sends **one** short prompt asking the agent to run the marker command, `cat` the denied file, and call the marker MCP tool.
- It prints one `PASS` or `FAIL` line per check:
  1. the repository's allow rule did not apply (the marker command was refused) and its hook did not run (no marker file): `--setting-sources user` ignores the repository's settings;
  2. the repository's MCP server was not started or offered: `--strict-mcp-config` ignores `.mcp.json`;
  3. `cat` on the denied folder was refused by a deny rule;
  4. the status line input contains `rate_limits` (Pro or Max) and `cost` fields;
  5. `autoContinueAtUsageLimit` is accepted under its documented name: Claude Code reports no invalid or unknown setting for it at startup (debug log).
- It records the hook payloads, the status line input and the transcript as fixtures under `apps/daemon/test/fixtures/claude-code-<version>/`. They are committed on the step's branch after the owner's run.
- When every check passes on a Claude Code newer than `CLAUDE_CODE_VALIDATED_VERSION`, that constant is raised to the version checked, in the same change.
- The script is checked in CI with `bash -n`, and here with a dry run against the fake `claude`.

**Done when** the owner has run the probe once with the real Claude Code, every check prints `PASS`, and the fixtures are committed. If a check fails, the next step starts by adjusting the specs with the owner.

### [ ] I. Agent profiles and assignee

- `agents/`:
  - common rules (06 section 6, including "read `CLAUDE.md` first" and the lot 2 ending with `ticket_submit`);
  - the four run message templates (03 section 3.2): the `implement` first message, the "please continue" message sent with `run.resume` after a usage-limit pause (detected or suspected), the wrapping of the owner's answer (live with `run.input`, or after the waiting run lifetime with `run.resume`), and the nudge, filled in into `run.start`; no agent-facing text is hard-coded in the server or the daemon;
  - `architect.md` and `web_dev.md` with their allowlists (03 sections 2.2 and 2.3).
- Table `agent_profiles` seeded from `agents/` at server start, version increased when a shipped file changed; role permissions of 06 section 5.
- `tickets.assignee_profile_id`: assignee in the create and edit forms (in `proposed` and `todo`), shown on cards and the ticket page, and an assignee filter on the board (02 section 6.3). Events.
- `docs/user/`: the Tickets page gains assignee; a short Agents section describing the two profiles.
- Allowlist smoke-test script `tools/smoke/allowlist-smoke.sh` for the owner (03 section 6): a scripted session per profile, in a scratch repository, reporting what was refused. Checked here with `bash -n` and with the fake `claude` only.

**Done when**:

- integration tests cover seeding, the version bump on a changed file, assignee edits refused outside `proposed` and `todo`, and an unknown profile refused;
- a snapshot test renders the first message and the appended instructions for a sample ticket;
- Playwright assigns a ticket and filters by assignee on both viewports;
- the smoke script passes a dry run with the fake `claude`.

### [ ] J. Runs (server) and Run now

- Migration: table `runs` (01 section 3.7, with `pause_reason`, `branch_head`, `commits`, `estimated_usage`) and `run_log_entries`; `tickets.branch_name`, `attempt_count`.
- **Run now** (07 section 3, lot 2):
  - eligibility and account checks with named refusals;
  - machine selection (07 section 4);
  - run `queued` then `dispatched`;
  - `todo` → `in_progress`;
  - dispatch acknowledgement timeout (run cancelled, ticket back to `todo`, no attempt).
- `run.state` and `run.events`:
  - run status mapping (05 section 4.7);
  - log storage with the "Longest stored log entry" setting and credential masking;
  - branch and commits at the end.
- `git.credential_request`: the token is sent only for a fetch of the run's own repository while the run is active.
- Commit author (04 section 4): a GitHub token saved before 0.3.0 whose account id is still unknown gets it at the first run (02 section 3.2; step C stores it at the save and at each check).
- **Stop run**, cancel stopping the run, the failure path (ticket back to `todo`, `attempt_count` raised, `system` comment), `machine_offline` (not counted), reconnection stopping runs the server no longer considers active.
- Revoking a machine fails its active runs with `machine_revoked` (not counted); disabling it lets them finish (01 sections 3.7 and 3.8, step C).
- Run now refuses an unusable, disabled, revoked or offline machine. The Claude Code version the daemon reports at run start is checked again as at `hello`: missing or below the minimum marks the machine unusable and fails that start (05 section 4.3).
- **Usage limits** on the server:
  - `paused_quota` with its reason;
  - account `limited` only for `detected`, until the reset time or `quotaFallbackDelayMinutes` (now used from 0.3.0);
  - **Resume** (refused before `limited_until` for a detected limit, allowed at once for a suspected one) through the Run now path with `run.resume`.
- API with protocol schemas for all of the above, and events with plain-words texts.

**Done when** integration tests with a scripted daemon cover:

- every Run now refusal;
- the acknowledgement timeout without an attempt counted;
- a run through to `succeeded` via `run.state`, and a failure raising `attempt_count` with its comment;
- Stop run, a `machine_offline` failure and a `machine_revoked` failure, none counted;
- the credential refused for another repository or an inactive run;
- a detected limit (with and without a reset time) marking the account and gating Resume;
- a suspected limit leaving the account available and resumable at once;
- log masking and truncation.

### [ ] K. MCP backend and questions

- Run tokens (random, scoped to one run, expired at run end; 06 section 2).
- MCP backend for the lot 2 tools, with permissions by role and every refusal of 06 section 3:
  - `ticket.progress`, never refused for frequency: the latest line is kept and published at most once per "Progress update interval";
  - `ticket.comment`, `ticket.give_up`;
  - `ticket.create` (`proposed`, per-run limit, input limits, archived or not-ready project);
  - the reduced `ticket.submit` (04 section 3.1): the daemon's clean-worktree and commits check, then the server's criteria check, `in_review`;
  - the reading tools, which page or summarise under the MCP output limit.
- **Accept** and **Reject** API (04 section 2).
- **Questions**:
  - `ticket.ask` → `waiting_human`;
  - the owner's answer sent with `run.input` to a live session;
  - after the waiting run lifetime, the session is closed and the answer resumes the same run on the same machine;
  - that machine offline → `machine_offline`, ticket back to `todo`.
- Every MCP call recorded as an event (06 section 7).

**Done when** integration tests with a scripted daemon cover:

- each tool with each of its refusals, and the role permissions;
- the `ticket.create` limit and its `proposed` result, then Accept and Reject;
- the reduced submission passing and failing;
- `ticket.ask` answered live and after the lifetime, and the offline case;
- an expired run token refused.

### [ ] L. Realtime, live screens and user documentation

- **SSE**:
  - `GET /api/stream` (authenticated): "changed" messages and log lines;
  - TanStack Query invalidation;
  - reload on reconnection and on focus;
  - the project setup polling, `projectSetupPollSeconds` and `GET /api/ui-settings` removed (with a CHANGELOG line). ADR if a library is used.
- **Ticket page**:
  - **Run now** with its refusal reasons, **Stop run**, **Resume**, **Accept**/**Reject**;
  - the answer box;
  - branch "on machine X, not on GitHub yet" with commits, attempt count;
  - the runs list and the report summary.
- Machines: active runs on the machine list and detail (02 section 9.2; left out of step D).
- Board: "Proposed" column, "created by agent", active run indicator with the progress line.
- **Run page** with the live log and estimated usage.
- Activity > Live runs and History (Queue stays "Coming in a later version").
- "Needs you": the compact status line per Claude account (02 section 4; left out of step D), questions answerable inline, tickets proposed by agents, work finished to check, paused runs (detected or suspected), machine offline with active work.
- `docs/user/`: a Runs page (Run now, watching, stopping, resuming, usage limits, what "suspected" means, where the commits are), a Questions section, the Tickets page (Accept and Reject, `in_review` in 0.3.0), Needs you, Activity, and the Settings reference.

**Done when** Playwright on both viewports, with a fake daemon, covers:

- Run now and its refusal reason;
- log lines appearing without reload;
- a question answered from "Needs you";
- an agent's ticket accepted;
- a run finishing with the branch and commits shown;
- a paused run resumed.

### [ ] M. End-to-end daemon test and limit capture tooling

- One integration test running the real server, the real daemon, tmux and the fake `claude` through the whole acceptance scenario:
  1. enrol;
  2. Run now;
  3. log lines;
  4. `ticket_ask`, answered;
  5. `ticket_create`;
  6. commits;
  7. `ticket_submit`;
  8. the ticket in `in_review` with the branch and commits.
- A second scenario covers a detected limit and Resume.
- `tools/spike/claude-code-spike.sh`: `--scan-limit` also reads `~/.orchestrator/claude-config/projects` and prints whole lines; the new `--probe-limit` starts one session with every hook and the status line logged, sends one short message, and records the payloads (run by the owner only while limited).

**Done when** both scenarios pass in `pnpm test`, and the spike script passes `bash -n` and its `--probe-limit` mode passes a dry run with the fake `claude`.

### [ ] N. Lot 2 check by the owner

- Version 0.3.0 prepared (CHANGELOG section, version numbers).
- The owner:
  1. checks the host prerequisites;
  2. runs the allowlist smoke-test script with the real Claude Code (and, if Claude Code was updated since step H, the probe script again);
  3. follows `docs/user/` alone on WSL: install the daemon from the server, enrol, `login`, service, create a ticket, Run now, watch it live, answer a question, accept a ticket the agent proposed, find the agent's commits on the branch shown by the ticket page and by `orchestrator-daemon status`.
- If the owner's checks pass on a Claude Code newer than `CLAUDE_CODE_VALIDATED_VERSION`, that constant is raised to the version checked.
- If the usage limit was reached during the lot, the owner runs `--scan-limit` and `--probe-limit`, and the detection table and fixtures are adjusted. Otherwise the capture moves to lot 4 (spec 10 already says so).
- Gaps found are fixed, each with its test; results recorded in this plan.

**Done when** the owner has run the scenario from the user documentation alone and confirmed it, and lot 2 is closed as version 0.3.0.

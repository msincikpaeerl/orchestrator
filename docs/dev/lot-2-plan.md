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

### [x] D. Accounts and machines screens, user documentation

- Machines section (02 section 9):
  - accounts: list and form (label, plan, maximum concurrent runs); the state moves to step L;
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

*Done 2026-09-25.* Owner's decisions, written into 04 section 8, 05 sections 2, 4.3 and 8, 02 section 4, and steps E, F, H, J, L and N above:

- the Claude Code minimum and highest validated versions are code constants, not settings; steps H and N raise the highest validated version when the owner's check passes on a newer Claude Code;
- the systemd user unit is `orchestrator-daemon`; checks run at each `hello`, so after an update or a fix the owner restarts the daemon (`systemctl --user restart orchestrator-daemon`, or stops and starts `orchestrator-daemon start`); the screens and Help say so;
- the daemon reports the Claude Code version it launches at each run start and the server checks it again (steps F and J);
- Help recommends nvm for Node.js and links to the official nvm instructions; `install-service` writes absolute `node` and script paths, and `doctor` checks the unit's `node` path (step E); after changing the Node.js version, the owner reinstalls the daemon and runs `install-service` again;
- the account status line on "Needs you" and the active runs on machines move to step L.

Choices within the step: the machine and its "Needs you" item carry `updateCommand` (the server's install command) for an incompatible daemon; `doctor` links are shown only when they are web addresses; the Help section `machines#keep-wsl-running` is the link `doctor` gives for the WSL idle timeout (step E); the e2e server drives the scripted daemon through its test-only control. A shutdown race of step C (queued status work running after the database closed) was fixed, with a regression test.

Owner's review of the step: the "Needs you" item is renamed "No machine enrolled yet" (02 sections 3 and 4; the decisions above keep the earlier wording); the account state is left out of the screens until step L; the Machines Help page turns on systemd before adding a machine, checks that WSL stays running, and has a Troubleshooting section (`doctor` and `status` marked "available from step E").

### [x] E. Daemon core

- `apps/daemon`:
  - CLI with `enroll`, `start`, `status`, `doctor`, `install-service`, `login` (starts Claude Code with the dedicated `CLAUDE_CONFIG_DIR` for the owner; never started by tests with the real `claude`), `attach`;
  - `~/.orchestrator/config.json` with mode `600` (the home folder is configurable for tests: tests never touch the real home);
  - connection with backoff constants, heartbeat, `hello` with the detected capabilities and the `doctor` results;
  - `install-service`: systemd user unit `orchestrator-daemon`, with the absolute paths of `node` and of the daemon's script written into it (05 section 2, owner's decision in step D).
- `doctor`: `git`, `tmux`, `claude` with versions against the minimums, systemd user session, lingering, the unit's `node` path (an error when it no longer exists or differs from the `node` running the daemon), managed Claude Code settings found, WSL detection. What it cannot read (the Windows `.wslconfig` `instanceIdleTimeout`) it prints as "check this yourself" with the documentation link (`<server URL>/help/machines#keep-wsl-running`, the section written in step D).
- Packaging: the daemon bundled into one file. The server builds the `.tgz` and serves it at `/downloads/orchestrator-daemon-<version>.tgz`. ADR: daemon packaging and bundler.
- `docs/dev/architecture.md` updated.

**Done when** daemon tests against the real server from step C cover enrol, connect, reconnect after a server restart, and revocation. `doctor` is tested with fake `git`/`tmux`/`claude` executables reporting missing, old and new versions. A test installs the served package into a temporary prefix and runs `orchestrator-daemon --version`.

*Done 2026-09-26.* Owner's decisions, written into 05 sections 2, 3.2, 4.2, 4.3, 4.6 and 8, and 09 section 7.2:

- **Service PATH**: `install-service` writes the terminal's `PATH` into the unit, without empty or relative entries (`.` included) and, on WSL, without entries under `/mnt/`, and prints it; `doctor` reports an error when `claude`, `git` or `tmux` is not found in the unit's `PATH`, a warning for `node` or `npm`; Help says to run `install-service` again after installing a tool or changing Node.js.
- **Plain `http://`** only for `localhost`, `127.0.0.0/8` and `::1`, with the reason in the refusal; `enroll --ca-file <path>` stores a PEM authority used for enrollment and the WebSocket, and checks are never disabled; `doctor` reports the scheme and the certificate, with a warning within 14 days of its expiry; 09 section 7.2 says Unraid and VPS daemons need HTTPS, pointing to the new Help section "Orchestrator on another computer".
- **Refusals that retrying cannot fix** (unknown or revoked token, incompatible protocol, `replaced`) stop the daemon with exit code 78, which the unit does not restart, and a message naming the cause and the fix, kept as the last stop reason shown by `doctor` and `status`. `replaced` counts only on the current connection, with a test of the sequence.
- **`doctor` grading**: the full table is in 05 section 8; Claude Code not logged in (`.credentials.json` present, never read) and managed Claude Code settings found are errors; service, systemd and lingering problems are warnings.
- **Control socket** `~/.orchestrator/daemon.sock`: read-only, never a secret; `status` shows whether the daemon runs as the service or in a terminal; `start` refuses when a daemon answers and removes a socket nothing answers on.
- **tmux**: sessions on the daemon's own server (`tmux -L orchestrator`), `TMUX` and `TMUX_PANE` unset in sessions (step F), `PreToolUse` denies Bash commands invoking `tmux` (tested in step G); `attach --write` asks for confirmation and warns.

Owner's review of the step: the WebSocket ping and the choices below are confirmed; the Add machine warning for a plain `http://` address outside `localhost` goes to step L.

Choices within the step: a WebSocket ping with each heartbeat, and a connection without a pong for two intervals is abandoned and replaced (the case where the "`replaced` on an abandoned connection" rule applies); a certificate that cannot be checked because the server is unreachable is a warning; `last-stop.json` is cleared by an accepted `welcome` or a new enrollment; the unit starts `start --service`, which is how `status` knows the mode; packaging with esbuild and `tar`, the daemon's libraries as `devDependencies` since they are bundled, and their licenses in the package (ADR 0026); `@orchestrator/daemon/testing` for the tests of both apps; the server test application gained `restart()`; `/daemon` and `/downloads` addresses are never answered with the UI.

### [x] F. Fake `claude`, workspace and tmux runner

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

Owner's decisions before the step (2026-09-26), written into 04 section 8 and 05 sections 2, 3.3, 4.2, 4.2.1, 4.3, 4.5, 4.8, 5 and 7:

- **Idle timeout**: time without any hook while the run is `working` or `idle`, paused while a tool call runs; when reached, the run ends with `idle_timeout` without a nudge. Nudges are sent at once when a turn ends. The setting's description is reworded.
- **Live log in F**: the daemon reads the transcript tolerantly (an unknown or malformed line is skipped and counted, and the count is shown in the run's log as a warning, never a failure), adds an entry for each message sent, masks credentials with the event log's patterns (moved to `packages/protocol`) and sends `run.events`.
- **`run.resume`** (the `--resume` launch path) is in F; closing the session after the waiting run lifetime and on a usage limit is in G.
- **Claude Code version at run start**: `run.state` `starting` carries `claudeCodeVersion`; missing or below the minimum, the daemon does not launch and ends the run with the new reason `claude_code_unsupported`.
- **Credential helper**: a one-shot socket per Git command (random name, mode 600, random key), `credential.helper=` reset first, `GIT_TERMINAL_PROMPT=0`; the server is asked only when Git asks; the helper answers only for the exact protocol and host of the clone URL, and a refusal is logged without the token (tested with a request for another host).
- **Hooks**: `hook <event> --run <id>` and `status-line --run <id>` use the run's socket; an unreachable daemon denies `PreToolUse` and lets every other event pass. The risk of an agent writing to its run's socket is written in 05 section 2 and in Help ("Agents on your own user"): the server's barrier is the run token (steps J and K).
- **Fake `claude` MCP**: a minimal JSON-RPC client of its own, tested in F against a small test MCP server; step G tests it against the real SDK-based server too.
- **Maximum duration** counts from the launch while `starting`, `working` or `idle`, kept in `state.json`.
- **Trust**: writes serialised and made while no run is `starting`; tested with several registrations at once while another process rewrites the file.
- **Bare clone**: remote branches fetched into `refs/remotes/origin/*`; the worktree uses the local ticket branch, else the remote one, else a new branch from `origin/<base>`; the author set with `extensions.worktreeConfig`.

*Done 2026-09-26.* Choices within the step, written into 05 sections 4.2.1, 7 and 8 where they are behaviour:

- trust is also checked before each launch and written again when missing, since Claude Code's own rewrites of `.claude.json` could drop an entry (found with the concurrent-writer test);
- the bare clone is made with `git init --bare` and a remote, and `core.bare` moves to its `config.worktree`: with `extensions.worktreeConfig` on, Git otherwise treats every worktree as bare and commits fail (found by the tests);
- the credential helper is the internal command `orchestrator-daemon git-credential`; the daemon waits for the server's `git.credential` at most the run's MCP call timeout; a credential request for a run it does not know gets none;
- at the end of a turn a queued message (an answer) is sent instead of a nudge;
- a run's folder is removed once the run has ended and the server acknowledged all its reports;
- the live log gains a `warning` kind; entries are sent in batches below half of `DAEMON_MESSAGE_MAX_BYTES`, the 1 MiB message limit now declared once in `packages/protocol`;
- the shared `maskSecrets` also hides machine tokens (`omt_…`), which 05 section 3.1 already required of the event log;
- the status line input reaches the run but is used from step G (collector);
- test homes live under `/tmp/od-test-*` so that a run's socket path fits the 107 bytes of a Unix socket.

`orchestrator-daemon status` listing local branches (decisions above, "The local branch") goes to step L (owner's decision, review of step F); until then `status` shows live runs only.

### [x] G. Permission enforcement, MCP relay and usage-limit detection

- **`PreToolUse` rules** (05 section 4.6), each with its reason:
  - `git push` and any command reaching GitHub;
  - changes to `.claude/`;
  - the daemon's folder `~/.orchestrator/` (machine token) and the Claude configuration folders;
  - other paths outside the worktree and run folder, exact for file tools and best effort for Bash.
- Settings deny rules for the same folders in the run's `settings.json`.
- **MCP relay**: `orchestrator-daemon mcp --run <id>` (stdio, wire names of 06 section 3), forwarding through `daemon.sock` and `mcp.call`/`mcp.result`; `UNAVAILABLE` after the MCP call timeout or while disconnected. `mcp.json` carries the Claude Code MCP tool timeout. New settings "MCP call timeout" and "Claude Code MCP tool timeout" with their cross-setting rule. ADR: MCP SDK.
- **Usage-limit module** (05 section 4.10) with its pattern table and fixtures from the documentation; the status line collector (reset time and `cost.total_cost_usd`); `run.quota_limited` and closing the session.
- **Decision tools on the daemon**: `ticket_submit`, `ticket_ask` and `ticket_give_up` seen through the relay (no nudge after them, `waiting_human` after `ticket_ask`); the session closed after the waiting run lifetime, keeping the worktree and the Claude session id (step F decision).
- **Profile settings generation**: allowlist and deny rules from a profile snapshot (`ToolSearch` always allowed).

**Done when** fake `claude` tests show:

- every deny rule refusing with its reason, and allowed calls passing, including a Bash `cat ~/.orchestrator/config.json` and a file-tool read of the Claude configuration refused;
- a tool call relayed end to end to a scripted server, and `UNAVAILABLE` on timeout and on disconnection;
- `detected` for the documented messages (with the status line reset time, with the message time, and with neither);
- `suspected` for a `rate_limit` without a known message, an `overloaded` and a `server_error` `StopFailure`, an API-error turn with no tool use, and an idle timeout right after one;
- no nudge in any of these cases;
- the estimated usage read from the status line;
- the fake `claude`'s own MCP client (step F) calling tools on the real SDK-based relay, so the two cannot drift (owner's decision, step F);
- a `git fetch` from the worktree getting no credentials while a global credential helper is configured in the test's home folder.

Owner's decisions before the step (2026-09-26), written into 04 section 8, 05 sections 4.3, 4.4, 4.5, 4.6, 4.8, 4.10 and 7, and 06 section 1:

- **Timeouts**: `mcp.json` carries the Claude Code MCP tool timeout, never the MCP call timeout, which is the daemon's wait for the server (as in the specs; the brief of the step said otherwise by mistake).
- **Daemon folder**: the settings deny rules list `~/.orchestrator/`'s entries one by one and leave out `worktrees/`, since a deny rule always wins and the worktree lives there; other runs' worktrees are refused by the hook. The run folder is not open to the agent.
- **Paths**: file tools reach the worktree only, checked exactly. Bash commands may also name `/dev/null` and the standard streams, the system temporary folder, and `/usr`, `/bin`, `/sbin`, `/lib*`, `/etc`, `/opt`, `/proc/self`; every other absolute path, `~`, `$HOME` and `..` leaving the worktree are refused.
- **GitHub and remotes**: every Bash Git command that talks to a remote (`push`, `fetch`, `pull`, `clone`, `ls-remote`, `remote add`/`set-url`, `send-pack`), any `gh` or `hub` command and any command naming a GitHub host are refused; `WebFetch` may read public GitHub pages. On WSL a global credential helper would give an agent's Git the owner's GitHub login, so the bare clone sets an empty `credential.helper` (no secret), and sessions run with `GIT_TERMINAL_PROMPT=0` and `GCM_INTERACTIVE=never`.
- **`.claude/` and `tmux`**: a Bash command naming a `.claude` path part is refused, even to read it; file tools may read the worktree's `.claude/`. A Bash command where `tmux` appears as a whole word or a path ending in `/tmux` is refused.
- **Allowlist**: the daemon always adds `ToolSearch` and `mcp__orchestrator`; the server enforces each role's MCP permissions.
- **API-error turns**: the module reads the hooks (`StopFailure`, and `Stop`'s message against the pattern table) and one transcript fact, the turn's last assistant entry marked `isApiErrorMessage`, which also covers the idle timeout after an error.
- **Reset time**: a message time is the next such local time (or weekday) on the machine; a status line window is full at 100 % with a `resets_at` still to come, and the later of two full windows counts.
- **Choices confirmed**: the relay uses `@modelcontextprotocol/server` 2.x (a stable release) with its low-level server and no validation of its own (ADR 0028); results are JSON text, refusals an `isError` result; calls get `UNAVAILABLE` at once while disconnected or when the connection drops; decisions take effect at the turn's `Stop`, a refused decision tool being no decision; the waiting run lifetime counts from that `Stop` and survives a daemon restart; `run.input` to a closed session is refused; the usage estimate is the status line's cost, else the transcript's last `cost-state`; the two new settings are in the Runs group, used from 0.3.0, the MCP call timeout strictly below the other.

*Done 2026-09-26.* Choices within the step:

- `@modelcontextprotocol/server` 2.1.0 is the `latest` tag and not a pre-release, and its README calls v2 "the stable release line", so ADR 0028 takes it. Its low-level `Server` is marked deprecated for ordinary use and kept "for advanced use cases": the two uses carry an ESLint exception naming the ADR.
- "Git commands that talk to a remote" also refuses `git remote update`, `remote prune`, `remote show`, `fetch-pack` and `submodule`, which contact a remote too. Git options before the subcommand (`-C`, `-c`, `--git-dir`, …) and wrappers (`env`, `timeout`, `xargs`, …) are skipped.
- Glob and Grep patterns are checked only when they are rooted (`/`, `~`) or hold `..`; a `PreToolUse` whose input cannot be read is refused, like an unreachable daemon.
- A call to an unknown tool name gets `VALIDATION_FAILED` from the daemon, listing the tools; the relay answers `UNAVAILABLE` when the daemon cannot be reached.
- The transcript's API-error mark is cleared at each message sent, so a hang after a later message is not taken for an API error.
- `state.json` gains the decision, the turn's tool use, the waiting start, the latest status line and the transcript facts, with defaults so a file written by 0.2.0 still loads.
- The empty `credential.helper` is set at each preparation, so bare clones made by 0.2.0 get it too. Step F's test "no helper in any Git configuration" now allows that empty helper only; the new global-helper test was checked to fail without it.
- The fake `claude`'s MCP client lists the tools after `initialize`, as Claude Code does; the runner tests share `runner-harness.ts`.

Owner's review of the step: in Bash commands a word is an absolute path only when its first folder exists at the filesystem root (after resolving `..`), so routes such as `/api/users` are not refused; a path not yet created under an existing root folder is still checked (05 section 4.6, Help).

### [x] H. Owner check of documented Claude Code behaviour

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

Owner's decisions before the step (2026-09-27), written into 05 sections 4.3 and 4.10:

- **Configuration folder**: the probe's own, in its scratch folder under `$TMPDIR`, logged in with the daemon's `login` code; the scratch folder holds real credentials, so it is deleted at the end (after the sanitised fixtures are copied out) unless `--keep`, which says where it is and that it holds credentials.
- **What the probe replaces**: the daemon's argument list (now `claudeArguments`, shared), permission rules and settings generation are used as they are; the hook, status line and MCP commands, which need a running daemon, point to a recorder; the model is `haiku`; the run settings add `enableAllProjectMcpServers: true`, so only `--strict-mcp-config` can keep the repository's server out.
- **Check 3**: the probe copies the daemon's layout (`.orchestrator/config.json` denied, the worktree under `worktrees/`), allows `Bash(cat *)`, and has the agent also read a control file next to `config.json` that no rule covers; `PASS` only when `config.json` is refused and the control is read.
- **Check 5**: Claude Code's settings reference gives `autoContinueAtUsageLimit` the scope "User or managed", so the daemon now also sets it in its user settings (`claude-config/settings.json`) before each launch. The probe records a debug log (`--debug-file`) and first starts a control session with a made-up setting and no prompt (no quota): if that setting is not reported either, check 5 prints `FAIL` ("cannot be proved this way").
- **One prompt** listing the actions as numbered commands. Each action must appear in the recorded `PreToolUse` payloads (or, failing that, in the transcript, which the result line says); an action never attempted prints `NOT ATTEMPTED`, and the summary asks for another run.
- **Fixtures**: hook payloads, status line inputs, the transcript and the control session's hooks, with the scratch path as `<probe>`, the home folder as `~` and credentials masked; the debug log stays in the scratch folder.

The owner's run (2026-09-27, Claude Code 2.1.283, `haiku`): checks 1, 2 and 4 `PASS`; check 3 `FAIL` because the control file was refused too; check 5 `FAIL` ("cannot be proved this way"). The transcript showed two different refusals: `config.json` got the deny rule's message ("Permission to use Bash with command … has been denied."), the control file `dontAsk`'s ("… because Claude Code is running in don't ask mode"). The raw transcript also held the Claude account's e-mail address, the global Git user and the organisation id (Claude Code's `session_context` and `credential_org` entries); it was never committed.

Owner's decisions after the run, written into 05 sections 4.3, 4.6 and 4.10, ADR 0002 and Help:

- **Check 3** is proved by the refusal messages: `PASS` when `config.json` is refused with the rule's message and the control is read or refused by `dontAsk`; `FAIL` when `dontAsk`, not the rule, refused `config.json`, or when a rule refused the control. `dontAsk` refusing a Bash `cat` outside the worktree that an allow rule matches is written into 05 section 4.6 as a second barrier.
- **Check 5** prints `INFO`, never `PASS`, since nothing is proved (`FAIL` only when the key is reported). The guarantee is that every usage limit, detected or suspected, closes the session (step G); the key in both settings files is an extra layer, to be confirmed by the usage-limit capture (05 section 4.10).
- **Fixtures** keep only the transcript entries the daemon reads (`user`, `assistant`, `system`, `cost-state`), mask every e-mail address, and pass a final guard: the account's e-mail and organisation id (from the session's data), the global Git `user.name` and `user.email`, and the home folder path must not appear in any fixture after sanitising, or nothing is written. This run's files were sanitised the same way and passed the guard.
- `CLAUDE_CODE_VALIDATED_VERSION` is raised to 2.1.283.
- Help > Machines > "Agents on your own user" says that Claude Code shows every agent the account's e-mail address and the Git user.

*Done 2026-09-27.* Checks 1 to 4 `PASS` and check 5 `INFO` on Claude Code 2.1.283 with the owner's grading; the sanitised fixtures are in `apps/daemon/test/fixtures/claude-code-2.1.283/`.

### [x] I. Agent profiles and assignee

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

**Owner's answers** (2026-09-27, written into the specs):

1. Profile files: a `---` header (`name`, `description`, `role`, `model`, `allowed_tools`) then the role instructions; the model is the alias `sonnet` (03 section 3, 01 section 3.6).
2. The profile version covers the common rules and the profile's file: a change of either raises it at the next start; the four templates are versioned with the application (03 section 3).
3. The Architect and the Web Developer share one allowlist: file tools, `WebFetch`, `WebSearch`, `ToolSearch`, package managers and `node`, local Git commands and basic file commands (03 section 2.2). The allowlist limits wasted turns and is not a security boundary; web access exposes agents to prompt injection, limited by the deny rules. Both points are in 03 section 2.2 and Help > Machines > "Agents on your own user".
4. The first message has a byte budget (`FIRST_MESSAGE_MAX_BYTES`, a protocol constant from Linux's 128 KiB argument limit): the ticket in full, comments newest first while they fit with a pointer to `ticket_comments`; a description too long is cut at a line boundary with a visible marker pointing to `ticket_get` (03 section 3.2). The first message is visible to the user's other processes (`ps`) at launch and never holds a secret (05 section 2).
5. `allowlist-smoke.sh` is built like the step H probe (recorder instead of the hook), one session per profile on `haiku` by default, `PASS`, `FAIL` or `NOT ATTEMPTED` per command, its own throw-away Claude configuration deleted with its credentials unless `--keep`, a dry run with the fake `claude` in CI, no personal data in its output or recorded files. The owner runs it in step N (03 section 6).
6. The board's assignee filter has an "Unassigned" option; a new ticket starts with no assignee; the API names profiles by key.

*Done 2026-09-27.* The server seeds `agent_profiles` at start from `agents/` and fills in the four templates (`apps/server/src/agents/`); the snapshot of the appended instructions and the messages for a sample ticket is `apps/server/src/agents/__snapshots__/run-messages.snapshot.md`. Two points for the steps that send these messages, settled by the owner at the review (2026-09-27, written into 03 section 3.2, 04 section 8, 07 section 3 and 02 section 6.4):

- step J: a cross-setting rule, maximum acceptance criteria × longest acceptance criterion ≤ 20,000 characters (`FIRST_MESSAGE_CRITERIA_MAX_CHARACTERS`: 80,000 bytes at 4 bytes per character, 20,000 bytes left for the rest of the first message), refused with a message naming both settings and the budget; **Run now** still refuses, with a clear message, a ticket whose first message cannot be built (`FirstMessageTooLarge`);
- step K: an answer delivered with `run.resume` is cut at a line boundary within `FIRST_MESSAGE_MAX_BYTES`, with a visible marker (a part of the answer template) telling the agent to read the full answer with `ticket_comments`; the quoted question is cut the same way with its own marker, and the answer has priority (the question is cut first); a live answer (`run.input`) is never cut.

### [x] J. Runs (server) and Run now

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
- First message size (03 section 3.2; owner's decision, review of step I): the cross-setting rule `ticketMaxAcceptanceCriteria` × `acceptanceCriterionMaxLength` ≤ `FIRST_MESSAGE_CRITERIA_MAX_CHARACTERS` (20,000) in `SETTING_ORDER`'s checks, refused naming both settings and the budget; Run now refuses a ticket whose first message cannot be built (`FirstMessageTooLarge`), in plain words.
- Revoking a machine fails its active runs with `machine_revoked` (not counted); disabling it lets them finish (01 sections 3.7 and 3.8, step C).
- Run now refuses an unusable, disabled, revoked or offline machine. The Claude Code version the daemon reports at run start is checked again as at `hello`: missing or below the minimum marks the machine unusable and fails that start (05 section 4.3).
- **Usage limits** on the server:
  - `paused_quota` with its reason;
  - account `limited` only for `detected`, until the reset time or `quotaFallbackDelayMinutes` (now used from 0.3.0);
  - **Resume** (refused before `limited_until` for a detected limit, allowed at once for a suspected one) through the Run now path with `run.resume`.
- API with protocol schemas for all of the above, and events with plain-words texts.

**Done when** integration tests with a scripted daemon cover:

- every Run now refusal, the ticket too large for its first message included;
- the criteria cross-setting rule refused with both settings and the budget named;
- the acknowledgement timeout without an attempt counted;
- a run through to `succeeded` via `run.state`, and a failure raising `attempt_count` with its comment;
- Stop run, a `machine_offline` failure and a `machine_revoked` failure, none counted;
- the credential refused for another repository or an inactive run;
- a detected limit (with and without a reset time) marking the account and gating Resume;
- a suspected limit leaving the account available and resumable at once;
- log masking and truncation.

Owner's decisions before the step (2026-09-28), written into 01 sections 3.4, 3.7 and 3.9, 03 section 3.2, 04 sections 2 and 5, 05 sections 4.3 and 6, 06 section 2 and 07 sections 3 and 4:

- **The machine holding the work**: until branches are pushed, Run now uses only the machine whose run last reported commits ahead of the base branch, and refuses naming it when it cannot take the run. When that machine was revoked, the run starts from the base branch elsewhere and a `system` comment says the earlier work on machine <name> is no longer available, with the number of commits lost.
- **Attempt number** in the first message: the ticket's earlier runs a machine acknowledged, plus one; `attempt_count` still counts failed attempts only. The first message points to the earlier commits when the chosen machine's latest run of the ticket reported some.
- **`claude_code_unsupported`** is a new failure reason, never counted, ticket back to `todo`.
- **Resume** goes only to the run's own machine and is refused with the named reason when it cannot take it (the run stays paused); `run.resume` not acknowledged in time puts the run back to `paused_quota` with an event, no attempt counted.
- **Stop run** cancels at once in one transaction (run, ticket, comment, events, revocation of the run token), then sends `run.stop`; the daemon's later end report only adds the branch. A session never reported ended is stopped at the next `hello`. A test makes an MCP call after Stop run (refused with `FORBIDDEN`).
- **Run now refusals** also name: project archived or not ready, GitHub token missing, unreadable or invalid, GitHub account id unreadable at the first run; "no machine" lists each machine with why it cannot take the run.
- Confirmed choices: a `submitted` end marks the run `succeeded` and moves the ticket to `in_review` together (step K stores the report when it accepts the submission); the run token is created here with its hash stored and checked on `mcp.call` (step K implements the tools); acknowledgement timers are set again at server start; an account past `limited_until` is treated as available by Run now, Resume and the screens at once, the first action writing the change and its event; "Needs you" gains "machine offline with active work" (left from step C).

*Done 2026-09-28.* Choices within the step:

- The setting "Longest stored log entry" (`logEntryMaxLength`, Runs group, 2,000 characters, 100 to 100,000), listed in the lot's decisions, is added here with the log storage; a cut entry ends with a marker giving the characters not kept.
- The run token is `ort_` and 256 random bits, stored as its hash; `mcp.call` checks it (`FORBIDDEN` when revoked, unknown or from another machine) and answers `UNAVAILABLE` for a valid token until step K implements the tools.
- Reports are handled once per message id through a `daemon_messages` table written in the report's transaction; log entries are stored once per position.
- A machine that disconnects between the checks and the sending of `run.start` cancels the run at once (not counted); an `ack` refusing `run.start` or `run.resume` is handled like the timeout, with the daemon's reason in the event.
- A run's pause reason is kept until it runs again, so a resume not acknowledged in time returns to the same pause.
- Resume is refused while the account is limited, also for a suspected pause (a limit detected by another run): no run starts on a limited account (07, section 5.2).
- The "work lost" comment is posted once: when a run is created on another machine after the run holding the commits.
- Among machines equally preferred (07, section 4), the name decides, so the choice is stable.
- Run events belong to the run's project; the event log's migration test compares only the event types a lot 1 database could hold.
- The clone URL is `https://github.com/<owner>/<name>.git` (`gitBaseUrl` of `buildApp`, for tests).

### [x] K. MCP backend and questions

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
  - after the waiting run lifetime, the session is closed and the answer resumes the same run on the same machine; the question, then the answer, are cut at a line boundary within `FIRST_MESSAGE_MAX_BYTES`, each with its marker from the answer template pointing to `ticket_comments`; the answer has priority over the question (03 section 3.2; owner's decisions, review of step I);
  - that machine offline → `machine_offline`, ticket back to `todo`.
- Every MCP call recorded as an event (06 section 7).
- **Processes left by a session** (owner's review of step J). Closing a run's tmux session (`kill-session`, at the end and when a waiting or paused run's session is closed) sends `SIGHUP` to the session's terminal only: a check with the real tmux 3.6 on 2026-09-28 showed a plain background process stopped, but a `nohup` and a `setsid` process still running afterwards, with the worktree removed under them. The Web Developer's text forbids long-running and background processes, but the daemon must not rely on that. Fix:
  - every process of a run carries a marker in its environment, `ORCHESTRATOR_RUN_ID=<run id>`, set on the tmux session's command (the environment is inherited through `nohup`, `setsid` and double forks);
  - where the systemd user session runs (the service's normal case, 05 section 2), Claude Code is started inside its own transient scope, `systemd-run --user --scope --unit orch-run-<run id> --collect`, and closing the session also stops that scope (`systemctl --user stop`), which ends every process in its cgroup whatever it did to its session or process group;
  - in every case, after `kill-session` the daemon sweeps `/proc` for processes of its own user whose environment holds the marker, sends `SIGTERM`, then `SIGKILL` to those left after a short grace period (a constant, like the backoff), and logs what it stopped; a process that cleared its environment escapes only the sweep, not the scope;
  - the same cleanup runs for a run found ended at a daemon restart (recovery from `state.json`), and before the worktree is removed.

  **Done when** a fake `claude` scenario starts a plain background process, a `nohup` one, a `setsid` one and a double-forked one, the run ends (and, in a second case, a waiting run's session is closed), and the test waits with a deadline until none of them is left (checked through `/proc` and the marker); the sweep is tested without systemd, and the scope where a systemd user session is available (as CI's runner has none, that case is marked and run by the owner's machine or the daemon test on WSL).
- **Sessions surviving a restart of the service** (owner's review of step J). The unit written by `install-service` (`apps/daemon/src/unit.ts`) sets no `KillMode`, so systemd's default `control-group` applies: stopping or restarting the service kills every process in its cgroup, including the tmux server (`tmux -L orchestrator`) the daemon started and every agent session in it. A `systemctl --user restart orchestrator-daemon`, which Help asks for after every fix, would then end all running runs, contradicting 05 section 6, where a restarted daemon finds its sessions again; step F's test restarted the daemon process without systemd. Fix, recommended: start the tmux server outside the service's cgroup, in its own transient scope (`systemd-run --user --scope --unit orchestrator-tmux --collect`, wrapping the command that starts the server), like the run scopes above, so the service's cgroup holds only the daemon; `KillMode=process` is not chosen, since it leaves every other child of the daemon (a `git` command, for example) behind on a stop, and systemd warns about such processes. Without a systemd user session (the daemon in a terminal), nothing changes. The choice and its reason are written into 05 sections 2 and 4.3.

  **Done when** a test on a machine with a systemd user session (run by the owner, or the daemon test on WSL; CI's runner has none) installs the service, starts a run with the fake `claude`, restarts the service, and sees the run's tmux session still alive and found again by the restarted daemon.

**Done when** integration tests with a scripted daemon cover:

- each tool with each of its refusals, and the role permissions;
- the `ticket.create` limit and its `proposed` result, then Accept and Reject;
- the reduced submission passing and failing;
- `ticket.ask` answered live and after the lifetime (with a long question cut before a long answer, each at a line boundary with its marker), and the offline case;
- an expired run token refused.

Owner's decisions before the step (2026-09-28), written into 01 section 5, 04 sections 2, 6 and 8, 05 sections 2, 4.3, 4.4 and 4.11, 06 sections 4.1, 4.2 and 7, and `docs/dev/testing.md`:

- **An answer the machine does not confirm**: a `run.resume` carrying the owner's answer that the machine does not acknowledge within the dispatch acknowledgement timeout, or refuses, fails the run with `machine_offline` as when the machine is offline: not counted, the ticket back to `todo`, the answer kept in the comments for the next run's first message.
- **The answer and the account**: the answer is delivered at once whatever the Claude account's state; the run counts against the account again from then on, so the account can be one run above its maximum until a run ends (the exception is written into 01, invariant 3); on a limited account the usual detection pauses the run.
- **`ticket_give_up`**: the reason and what was tried are posted as the agent's `note`, and the reason is kept as the run's outcome; the run's end adds the usual `system` comment.
- **Reading tools' output**: at most `MCP_OUTPUT_MAX_CHARACTERS` (40,000 characters, a code constant in `packages/protocol`); pages hold whole items while they fit, at least one, and `ticket_list` at most 50; a single text above it is cut at a line boundary with a marker giving the characters left out. The default settings never cut.
- **Events of MCP calls**: not every call is an event. Calls that change something write the events of that change (`ticket_comment`, `ticket_ask`, `ticket_create`, an accepted `ticket_submit`, `ticket_give_up`, and `ticket_progress` when a new line is shown); reading calls and refusals appear in the run's log only.
- **Sweep grace period**: 5 seconds, a code constant (`SWEEP_GRACE_MS`), listed among the exceptions of 04 section 8 with its reason.
- **systemd tests**: they run only with `ORCHESTRATOR_TEST_SYSTEMD=1` and a systemd user session; their units are named `od-test-<hash>-…` from the test home, never `orchestrator-tmux` or `orchestrator-daemon`; every `od-test-*` unit is stopped after each test and before the first one; `docs/dev/testing.md` says what they create and how to run them.

*Done 2026-09-28.* Choices within the step:

- The setting "Progress update interval" (`progressUpdateIntervalSeconds`, Runs group, 60 seconds, 0 to 3,600), listed in the lot's decisions, is added here. The latest line is stored at every call; it is shown at once when the interval has passed since the last line shown, else by a timer at the end of the interval (restored at server start), with its `run.progress` event.
- "Max tickets an agent may create per run" is read with the project's override when the run starts and kept on the run (`runs.max_agent_tickets`), since runs keep the values they started with (04, section 8).
- A second `ticket_ask`, and any decision tool after an accepted `ticket_submit` or `ticket_give_up`, are refused with `INVALID_TRANSITION` (06, section 4.2).
- Agent events carry the new actor `agent`, with the profile's key and name and the run in the payload; `ticket.submitted` and `run.progress` are new event types.
- Tickets and comments name the agent and run behind them (`createdByAgent`, `agent` in the API); the ticket page shows "Agent <name>" for an agent's comment. The API gains `POST …/answer`, `POST …/accept` and `POST …/reject`, and the ticket's `dodReport`.
- A live answer's `run.input` may hold the question and the answer whole, each up to the longest comment: its text ceiling is derived from that setting's range. A `run.resume` message is checked against `FIRST_MESSAGE_MAX_BYTES`.
- An answer to a run paused on a usage limit is stored and moves the ticket back to `in_progress`; **Resume** then sends the "please continue" message, which points to `ticket_comments`.
- The systemd scopes are used when `systemctl --user show-environment` answers the daemon; unit names get the `od-test-<hash>-` prefix whenever `ORCHESTRATOR_HOME` is not `~/.orchestrator`. New tmux sessions are started one at a time, so two runs never both start the server in its scope.
- Found by the tests: tmux gives a new session the `PATH` of its client, not the one passed with `-e`. It changes nothing for the daemon, whose own `PATH` is the one it passes; the runner harness gained `addSystemPath()`.
- `apps/server/test/run-harness.ts` gathers the run set-up for the MCP tests; `apps/daemon/test/scripted-server.ts` is the scripted server shared by `daemon-runs.test.ts` and `systemd.test.ts`.

### Step L, split in two

Step L (realtime, live screens and user documentation) was too large for one session. The owner split it into L1 and L2 before any code was written (2026-09-29), and answered the points the specs left open, written into 01 section 3.7, 02 sections 1, 4 and 7, 04 section 8, 05 section 8 and 09 section 4:

- **Log lines over the stream**: the stream carries a notice that a run has new log entries up to an entry number; the screen fetches the entries after the last one it holds (existing log endpoint), so nothing is lost across a reconnection and the server keeps no record of what each screen shows.
- **Working and waiting times**: two totals kept on the run at each status change, working for `starting` and `running`, waiting for `waiting_human` and `paused_quota`, neither for `queued` and `dispatched`; an active run's current period is added when shown.
- **Account status line**: "Available" or "Limited until <time>"; a passed limit time shows "Available"; `paused_manual` (lot 4) shows "Paused"; no next window before lot 4.
- **Answer box**: the same on the ticket page, the run page (while its run waits) and "Needs you".
- **`orchestrator-daemon status`**: a local ticket branch's commits are those not on any branch fetched from GitHub ("not on GitHub yet"), the same list the run reported, since nothing is pushed in lot 2.
- **Stream keep-alive and reconnection**: every 20 seconds and 3 seconds, code constants listed among the exceptions of 04 section 8.

### [x] L1. Live stream, ticket page and run page

- **SSE**:
  - `GET /api/stream` (authenticated): "changed" messages and run log notices, closed at logout;
  - TanStack Query invalidation;
  - reload on reconnection and on focus;
  - the project setup polling, `projectSetupPollSeconds` and `GET /api/ui-settings` removed (with a CHANGELOG line). ADR for how changes reach the stream.
- **Runs**: working and waiting times stored (01 section 3.7).
- **Ticket page**:
  - **Run now** with its refusal reasons, **Stop run**, **Resume**, **Accept**/**Reject**;
  - the answer box;
  - branch "on machine X, not on GitHub yet" with commits, attempt count;
  - the runs list and the report summary.
- Board: "Proposed" column, "created by agent", active run indicator with the progress line.
- **Run page**: status with the pause reason, times working and waiting, estimated usage, progress line, branch and commits, the answer box while the run waits, and the live log.
- `docs/user/`: a Runs page (Run now, watching, stopping, resuming, usage limits, what "suspected" means, where the commits are), a Questions section, the Tickets page (Accept and Reject, `in_review` in 0.3.0), and the Settings reference.

**Done when**:

- Playwright on both viewports, with the scripted daemon, covers:
  - Run now and its refusal reason;
  - log lines appearing without reload;
  - an agent's ticket accepted;
  - a question answered on the ticket page;
  - a run finishing with the branch and commits shown;
  - a paused run resumed;
- integration tests cover the stream refused without a session, a "changed" message after a ticket change, a log notice after `run.events`, the stream closed at logout, and the removed setting and endpoint.

*Done 2026-09-29.* Choices within the step:

- How changes reach the stream: `recordEvent` and the run log storage send PostgreSQL `NOTIFY` in their own transaction, delivered only at commit; one pool connection holds `LISTEN`, is replaced after 3 seconds when lost, and the streams then send `resync` (ADR 0029, 09 section 4). No SSE library. The stream checks its session at each keep-alive and each session change.
- The run page is `/activity/runs/:id`; **Run now** opens it. **Stop run** asks for a confirmation saying what happens to the ticket and the branch. On a ticket an agent proposed, **Reject** replaces **Cancel**.
- `Run` gains `outcome`, `workingMs`, `waitingMs` and `statusSince`; board tickets carry their active run (`activeRun`, with the progress line shown). The run statuses moved to `packages/protocol/src/api/run-status.ts`, shared by tickets and runs. Display constant `PROGRESS_CARD_MAX_LENGTH` (120 characters) for the card's progress line.
- The "Projects" group of Settings > Limits is removed with its only setting.
- The e2e server's scripted daemon acknowledges the server's commands itself, and two controls (`/daemon/run`, `/daemon/request`) play runs; `runs.e2e.ts` was checked to fail with the stream turned off.
- Found by the tests: `daemon-package.test.ts` left a downloaded package unread, which kept a connection busy and the test server from closing; the test now reads it. Whether it hung depended on timing: it also hangs without the change feed (checked at the owner's review), so it was not caused by the stream.
- Shutdown with open streams (owner's review): SIGTERM ends every open stream at once (the stream route's `preClose` hook) and the process exits in about 50 milliseconds, far from Docker's 10-second kill timeout. `apps/server/test/shutdown.test.ts` starts `src/main.ts` as its own process, opens two streams, sends SIGTERM and checks both streams end and the process exits with code 0 in under 3 seconds; it was checked to fail with the hook removed.
- CI split into parallel jobs with a final `ci` job, the only check branch protection requires (ADR 0030). On PR #26: build 39 s, checks 1 min, docker 1 min, e2e 3 min, test 9 min, ci 3 s; before, the single `verify` job took 9 min 22 s and then hit its 10-minute timeout.

Follow-up before L2: test database speed (template database, test-only PostgreSQL settings), chore branch `lot2/l1b-test-databases`. The CI test job takes 9 min of its 15-min timeout. *Done 2026-09-29* (ADR 0031): the tests use their own PostgreSQL (`postgres-test` in `docker/compose.dev.yml`, port 5433, durability turned off) and copy a template migrated once per version of the migration files. Locally the suite went from 71 s to 45 s, and the database work in it from about 410 s to about 53 s. On PR #27 the CI test job went from 9 min to 6 min (build 47 s, checks 1 min, docker 1 min, e2e 3 min, ci 3 s), with the settings confirmed in its log.

Sharding (owner's decision: not now): if the CI test job exceeds 10 minutes, run `pnpm exec vitest run --shard=1/2` and `--shard=2/2` (or 3 shards) as a matrix of the `test` job, each shard listed in the needs of `ci` through the matrix job; each shard runs about half the test files plus about 1 min of setup. Branch protection is unchanged, since it requires only `ci`.

### [x] L2. Needs you, Activity, Machines and daemon status

- "Needs you": the compact status line per Claude account (02 section 4), questions answerable inline, tickets proposed by agents with **Accept** and **Reject**, work finished to check with **Mark as done manually**, paused runs (detected or suspected) with **Resume** and **Stop run**, machine offline with active work.
- Activity > Live runs (with **Stop run** and the attach command) and History with filters and paging (Queue stays "Coming in a later version").
- Machines:
  - each Claude account's state on the account list (02 section 9.1; left out of step D);
  - active runs on the machine list and detail (02 section 9.2; left out of step D);
  - **Add machine** warns when `PUBLIC_URL` is plain `http://` and not `localhost` (`127.0.0.0/8`, `::1`), since the daemon refuses that address (05 section 3.2), and links to Help > Machines > Orchestrator on another computer (owner's decision, review of step E).
- `orchestrator-daemon status` lists the local ticket branches of the machine's bare clones, with their head and commits not on GitHub yet (05 section 8; owner's decision, review of step F).
- `docs/user/`: Needs you, Activity and Machines pages.

**Done when**:

- Playwright on both viewports, with the scripted daemon, covers:
  - a question answered from "Needs you";
  - a proposed ticket accepted from "Needs you";
  - a paused run resumed from "Needs you";
  - the Add machine warning for a plain `http://` address outside `localhost`;
  - a limited account shown as limited, then as available once its time has passed;
  - an active run on the machine page;
  - Live runs and History;
- a daemon test shows `orchestrator-daemon status` listing a ticket branch kept after a run, with its commits.

Owner's decisions before the step (2026-09-29), written into 02 sections 4, 6.4, 7 and 9.2, 04 sections 1 and 2, 05 section 8 and 10 (lot 3):

1. **No "account limited" item** of its own: the account status line shows it, the runs it paused are listed, and **Run now** says why it refuses with the time (already so since step J).
2. **Paused run items**: a detected limit reads "you can resume after <time>", marked "estimated" when the time comes from the fallback delay; **Resume** is refused until then (05 section 4.10 and 07 section 5.2 already give a detected limit a time in every case). A suspected limit allows **Resume** at once, with the note "the run may pause again if it was the limit". The account stores whether its limit time is estimated.
3. **`orchestrator-daemon status`** lists the branches whether a daemon runs or not, strictly read-only: no fetch, no lock, no write (Git's optional locks off), never interfering with a daemon starting at the same time.
4. **History**: the outcome filter is the end state (succeeded, failed, cancelled); each failed run's row shows its failure reason.
5. **Live runs**: each live run shows only its latest log entry (its current activity), updated live, with a link to the run page for the full log. No new setting or constant.
6. Live runs lists every active run, waiting and paused ones marked; items of "Needs you" are ordered by when their reason began.
7. **Request changes from `in_review`** (lot 2, while no Quality run exists): the owner's comment is required and posted as a `status_change` comment, `attempt_count` is unchanged, the branch is kept, and the ticket returns to `todo`. The confirmation then offers **Run now** directly (the existing action, one click, with its usual refusals); no combined server action. Whether it stays in lot 3 is noted in 10 (lot 3).

*Done 2026-09-29.* Choices within the step:

- The account stores whether its limit time is estimated (`claude_accounts.limited_until_estimated`, migration `0012`, filled for an account already limited from its latest `account.limited` event). A run gains `resumeAfter` (its account's limit time and whether it is estimated), so the ticket page, the run page, Live runs and "Needs you" say the same thing; **Resume** is disabled until that time and becomes available by itself on the owner's clock (the server still refuses it before).
- "Needs you" items `question`, `ticket_proposed`, `work_to_check` (the submission's summary and the run) and `run_paused` (the whole run), on active projects only; `GET /api/needs-you` also returns the account status lines. The cards reuse the ticket page's answer box and actions, now in `apps/web/src/tickets/actions.tsx`. After **Request changes** the ticket leaves `in_review`, so the button is gone: the page itself shows the **Run now** offer (`RunNowOffer`), and the offer is triggered in the mutation's own `onSuccess`, before the screens are read again (a callback given to `mutate` never ran; found by the Playwright test).
- `GET /api/runs/live` (optional `machine`) and `GET /api/runs/history` (filters, and a cursor of end time and id); `RUN_HISTORY_PAGE_SIZE` (50) is a display constant. The run service's `view` became `list`, one query for any number of runs. The machine list and page use the Live runs endpoint (no change to the machine API). A run log notice also reloads Live runs, so the latest entry follows the agent.
- History's filters are kept in the address under their own names (`runProject`, …), apart from the event log's.
- The loopback rule of the daemon's address check moved to `packages/protocol` (`isLoopback`, `isRefusedPlainHttp`), shared by the daemon and `GET /api/machines/server-address`, which the Add machine warning reads. The e2e test server runs on `localhost`, so its Playwright test stubs that endpoint's answer; the server's rule is covered by the integration test with `startTestApp`'s new `publicUrl` option.
- `orchestrator-daemon status` reads the bare clones itself with `git for-each-ref` and `git log <branch> --not --remotes=origin`, with `GIT_OPTIONAL_LOCKS=0`; a Git error on one clone is printed and the others are still listed. The control socket's runs gain their ticket, repository and branch, so a branch a live run uses says so; `hello` still sends only its three fields.
- Existing tests changed with the behaviour: the Activity page is no longer "coming in a later version" (only its Queue is), the event log test reads its fields in its own section (History also has a **Project** field), and the suspected-limit text gained the note the owner asked for.

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
  3. restarts the service during a run (`systemctl --user restart orchestrator-daemon`) and sees the run's session survive and go on (step K, "Sessions surviving a restart of the service");
  4. follows `docs/user/` alone on WSL: install the daemon from the server, enrol, `login`, service, create a ticket, Run now, watch it live, answer a question, accept a ticket the agent proposed, find the agent's commits on the branch shown by the ticket page and by `orchestrator-daemon status`;
  5. with real runs: `orchestrator-daemon status` after a run, daemon running and stopped; on the phone, Needs you → Request changes → Run now, and the next run reads the comment (owner's review of step L2).
- If the owner's checks pass on a Claude Code newer than `CLAUDE_CODE_VALIDATED_VERSION`, that constant is raised to the version checked.
- If the usage limit was reached during the lot, the owner runs `--scan-limit` and `--probe-limit`, and the detection table and fixtures are adjusted. Otherwise the capture moves to lot 4 (spec 10 already says so).
- Gaps found are fixed, each with its test; results recorded in this plan.

**Done when** the owner has run the scenario from the user documentation alone and confirmed it, and lot 2 is closed as version 0.3.0.

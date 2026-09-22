# 0002 — Running Claude Code interactively from the daemon

- Status: accepted
- Date: 2026-09-22
- Validated on: Claude Code 2.1.280, Linux (WSL 2)
- Evidence: `tools/spike/claude-code-spike.sh`, `claude-code-spike-v2.sh`, `claude-code-spike-v3.sh` and their reports

## Context

Agents run on the owner's Claude Pro subscription, shared with personal use. The owner does not want API-key billing. Headless mode (`claude -p`) was announced to move to separate billing in May 2026, then postponed, and may change again. The daemon therefore drives Claude Code in **interactive mode**, inside tmux, without ever reading the terminal display (00, principle 5).

This only works if Claude Code can be started, observed, controlled and restricted without human interaction. Three spike scripts checked each assumption of spec 05 on the real tool.

## Decision

### Launch

- One detached tmux session per run, working directory = the run's Git worktree.
- Environment: `CLAUDE_CONFIG_DIR` points to a dedicated configuration folder (see Workspace trust).
- Command built as an argument list, in this order: `--mcp-config <file>`, `--settings <file>`, `--permission-mode dontAsk`, `--model <model>`, `--append-system-prompt <text>`, optionally `--resume <session id>`, then `--`, then the first message.
- `--mcp-config` accepts several values: placed last before the message, it swallowed the message as a second configuration and Claude Code exited. Putting it first and always passing the message after `--` prevents this.
- `--append-system-prompt-file` does not exist; the text is passed with `--append-system-prompt`. It is applied in interactive mode (verified with a marker the agent returned).

### Observation

- `SessionStart` hook: `session_id`, `transcript_path`, `cwd`, `source` (`startup` or `resume`), `model`.
- `Stop` hook fires at the **end of every turn**, not only at session end, and includes `last_assistant_message`, `permission_mode`, `prompt_id`. The daemon knows each turn's outcome without parsing the transcript.
- `Notification` hook fires with "Claude is waiting for your input" when a session is idle.
- The transcript (JSONL, under `<config>/projects/<path>/<session id>.jsonl`) contains, among others, `user`, `assistant`, `system`, `attachment` and `cost-state` entries. `cost-state` gives an equivalent cost and token usage per model.
- Resuming with `--resume <id>` keeps the same session id.

### Input

- Text is sent to an idle session with `tmux load-buffer`, `tmux paste-buffer -p`, then Enter. A three-line message arrived as a single message.
- An interactive session left idle for 30 minutes answered normally.

### Permissions

- `--permission-mode dontAsk` refuses any tool or command not allowed, with no prompt, and tells the agent why. Allowed commands run without a prompt.
- Allowlist rules are strict: `Bash(echo:*)` did not cover `echo allowed > allowed.txt`. Profiles are checked by a smoke test (03, section 6).
- A `PreToolUse` hook can deny a call with a reason the agent reads. It is used for rules an allowlist cannot express (no `git push`, no change to `.claude/`, nothing outside the worktree).
- `ToolSearch` must be allowed: Claude Code uses it to load MCP tools.
- MCP servers passed with `--mcp-config` are used without approval.
- `--dangerously-skip-permissions` and `bypassPermissions` are never used.

### Workspace trust

- Claude Code shows a trust dialog the first time it starts in a folder, and runs no hooks before it. Its default option is **"No, exit"**.
- Trust is recorded per exact path and is **not inherited** from parent folders.
- For a Git worktree, trust is recorded on the **main repository** path (the bare clone), not the worktree path. All worktrees of a trusted repository start without a dialog.
- A trust entry written in advance (`projects["<path>"].hasTrustDialogAccepted: true`) is honoured.
- Decision: agents run with a **dedicated configuration folder** (`~/.orchestrator/claude-config`), logged in once by the owner with `orchestrator-daemon login`. The daemon registers trust for each bare clone when it first clones it, with an atomic write to that folder's configuration file. The owner's personal `~/.claude.json` is never touched, which was verified. Transcripts of agents stay separate from the owner's history.

### Cost awareness

- A trivial three-turn test cost about $0.12 equivalent, almost all of it 217,000 tokens read from cache: each turn reloads roughly 70,000 tokens of context, even for a one-line answer.
- Consequences: few turns per run, at most 2 nudges, and a daily budget that can be expressed in estimated usage (07, section 5.4).

## Alternatives considered

- **Headless mode (`claude -p`).** Simpler and structured, but tied to a billing policy that may change and that the owner does not want to depend on. Kept possible behind the runner abstraction.
- **Reading the terminal display.** Fragile and forbidden by principle. Used only inside the spike scripts to detect dialogs.
- **Accepting the trust dialog with keystrokes.** Requires reading the screen, and the default option exits Claude Code.
- **Trusting a parent folder of all worktrees.** Does not work: trust is not inherited.
- **Fixed worktree slots reused across runs.** Unnecessary once trust was found to be recorded per repository.
- **Writing trust in the owner's `~/.claude.json`.** The file is written continuously by the owner's own sessions; concurrent writes could corrupt it.
- **Remote Control (`claude remote-control`).** A persistent server controlled from claude.ai or the mobile app, with no interface the Orchestrator server can call. Not a replacement for the daemon; a possible later addition to let the owner take over a session from a phone.

## Consequences

- Spec 05 is updated with the launch arguments, observation sources, permission layers, workspace trust and the dedicated configuration folder.
- Machine setup gains one interactive step: `orchestrator-daemon login`.
- The daemon relies on an undocumented configuration key (`hasTrustDialogAccepted`). If Claude Code changes it, sessions will stop reporting `SessionStart`; the daemon fails such runs quickly with an explicit reason (05, section 4.2.1).
- The supported Claude Code version range starts at 2.1.280. The spike scripts are run again before raising it.
- Trusting a workspace activates its project settings; agents are prevented from editing `.claude/` by the `PreToolUse` hook.

## Open point

- **Usage-limit signal.** Not yet observed. To capture with `claude-code-spike.sh --scan-limit` right after the limit is reached, then add to this ADR and to 05, section 4.10.

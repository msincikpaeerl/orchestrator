# 0027 — Testing the daemon with real tmux and a fake `claude`

- Status: accepted
- Date: 2026-09-26

## Context

The daemon drives Claude Code in interactive mode inside tmux (ADR 0002, 05 section 4). Its runner must be tested in CI and in every session, but no test may start a real Claude Code session or use the owner's subscription (working rule 10). What the daemon relies on is the tmux commands it runs, the launch arguments, the hooks and status line Claude Code calls with JSON on standard input, the transcript it writes, the MCP server it starts, and the text pasted into its terminal. It never reads the terminal display (00, principle 5).

## Decision

- **Real tmux, real Git.** Runner tests use the host's `tmux` (3.2 or later, a host prerequisite; CI installs it from apt and prints `tmux -V`) and `git`. Each test sets `TMUX_TMPDIR` to its own folder, so its `tmux -L orchestrator` server never meets the owner's daemon or sessions.
- **A fake `claude`** in `apps/daemon/test/fake-claude/`, a TypeScript program run with Node.js and `tsx` through a `claude` shell script that `installFakeClaude` writes into the test's `bin` folder. It:
  - checks the launch arguments of 05 section 4.3 and their order, and refuses any other;
  - runs the hook commands of the run's `settings.json` (`SessionStart`, `PreToolUse`, `PostToolUse`, `Stop`, `StopFailure`, `Notification`, `SessionEnd`) and its status line command, with the inputs Claude Code documents, and honours a `PreToolUse` denial;
  - writes transcript lines under `CLAUDE_CONFIG_DIR/projects/<cwd>/<session id>.jsonl`;
  - starts the MCP server of `--mcp-config` and calls its tools, with a minimal JSON-RPC client of its own (tested here against a small test server; step G tests it against the real relay too, so the two cannot drift);
  - reads messages from its terminal, one per bracketed paste or typed line;
  - runs commands for real (commits in the worktree);
  - plays each usage-limit signal of 05 section 4.10: a `StopFailure` of any type with its message, a status line at 100 %, an API error turn, and a session that hangs.
- **Scenarios** are JSON files (`scenario.ts` holds their schema): the version `--version` prints, a delay or a missing `SessionStart` (a startup dialog), and the steps of each turn. A test can give each run its own scenario, keyed by the run id that names the worktree. The fake records what it did in `log.jsonl` for the tests to check.
- **Time**: runner tests shorten the run limits with a time scale (one second of a setting lasts a few milliseconds), as the server's tests do for heartbeats.
- **Git credentials** are tested against a local Git HTTP remote: `git http-backend` behind a small Node.js server asking for Basic authentication (`apps/daemon/test/git-http-server.ts`).

## Alternatives considered

- **Mocking tmux and Git**: the daemon's risks are in how it calls them (argument lists, bracketed paste, sessions surviving a daemon restart, worktrees, credential helpers); mocks would test the mocks.
- **A fake `claude` in shell**: JSON inputs, the MCP client and raw terminal input are much harder to get right in shell than in TypeScript.
- **A fake bundled with the daemon package**: test code has no place on the owner's machines.
- **Recorded sessions of the real Claude Code played back**: they would hold the owner's data and still need a program to play them; the fixtures captured by the owner's probe (plan step H) are used to check the fake's inputs instead.

## Consequences

- `pnpm test` needs tmux and Git on the host, stated in `docs/dev/setup.md`.
- The fake follows the documentation, not the real tool: the owner's probe (plan step H) records the real payloads as fixtures, and the fake is adjusted when they differ.
- Hooks and the fake run through `tsx`, about a third of a second per hook call, so runner tests take seconds rather than milliseconds; they are kept few and focused.

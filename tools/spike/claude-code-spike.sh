#!/usr/bin/env bash
# Claude Code spike — verifies the assumptions listed in docs/specs/05-daemon.md, section 9.
# For the owner only (working rule 10): sessions, `pnpm verify` and CI run its syntax check and
# the dry run of --probe-limit against the fake claude, never a real session.
#
# Usage:
#   ./claude-code-spike.sh              Standard run (about 5 minutes, a few short Sonnet turns)
#   ./claude-code-spike.sh --long       Also tests an idle session kept open for 30 minutes
#   ./claude-code-spike.sh --scan-limit [--days <n>]
#                                       Prints the transcript lines holding an API error or a
#                                       usage-limit message (no session, no quota): run it right
#                                       after you hit your usage limit for real
#   ./claude-code-spike.sh --probe-limit [--keep] [--model <alias>] [--claude <executable>]
#                                        [--fixtures <folder>] [--dry-run]
#                                       Records what Claude Code sends while you are limited
#
# --scan-limit reads the transcripts changed in the last 2 days (or --days) in ~/.claude/projects
# and ~/.orchestrator/claude-config/projects, and prints those whole lines, with e-mail addresses,
# credentials and your home folder masked. It never starts Claude Code.
#
# --probe-limit (05, section 4.10) never tries to reach the limit: run it only while Claude Code
# already shows you "You've hit your ... limit". It starts ONE session with the daemon's own
# settings (every hook and the status line recorded, autoContinueAtUsageLimit: false), in a
# scratch folder under the temporary folder with its own Claude configuration (log in once: no
# quota), and sends ONE message, "Reply with the word OK.": refused at no cost while you are
# limited; if the limit is over, answered in a few tokens. Model: sonnet, the one runs use (a
# Sonnet-only limit would not show on another model). It prints what was recorded and what the
# daemon's detection makes of it, and writes sanitised fixtures (default
# apps/daemon/test/fixtures/usage-limit/claude-code-<version>/) only when a limit was seen and
# nothing personal or credential-like is left in them. It never commits them: have them
# reviewed before any commit. The scratch folder (with its credentials) is deleted at the end,
# also on failure or Ctrl-C, unless --keep.
#   --keep       keep the scratch folder (it holds Claude credentials: delete it yourself)
#   --model      model alias (default: sonnet)
#   --claude     the claude executable to use (default: claude from PATH)
#   --fixtures   where the fixtures go
#   --dry-run    skip the login; only with the tests' fake claude given with --claude
#   Exit code: 0 limit captured (fixtures written), 2 no limit seen, 3 stopped, refused, or
#   fixtures withheld.
#
# Every mode but --scan-limit starts the real Claude Code: it refuses to run in CI or without a
# terminal, and asks you to type yes before any session.
#
# Requirements: claude (logged in), tmux, node, git, and `pnpm install` done in the repository.
# Output of the standard run: a working folder under ~/orch-spike.XXXXXX with logs and
# spike-report.md.

set -uo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=../smoke/lib/real-claude-guard.sh
source "$REPO/tools/smoke/lib/real-claude-guard.sh"
TSX="$REPO/apps/daemon/node_modules/.bin/tsx"
LIMIT_HELPER="$REPO/apps/daemon/scripts/usage-limit-probe.ts"

MODE="standard"
case "${1:-}" in
  --long) MODE="long" ;;
  --scan-limit) MODE="scan" ;;
  --probe-limit) MODE="probe-limit" ;;
  -h | --help) sed -n '2,46p' "$0"; exit 0 ;;
  "") ;;
  *) echo "Unknown option: $1 (see --help)"; exit 1 ;;
esac
(($# > 0)) && shift

MODEL="${SPIKE_MODEL:-sonnet}"
TURN_TIMEOUT="${SPIKE_TURN_TIMEOUT:-240}"

stop() {
  echo "STOPPED: $*" >&2
  exit 3
}

# ---------------------------------------------------------------------------
# Scan mode: usage-limit traces in existing transcripts (check 4). No session.
# ---------------------------------------------------------------------------
if [[ "$MODE" == "scan" ]]; then
  [[ -x "$TSX" ]] || stop "the repository's packages are missing: run pnpm install in $REPO first."
  "$TSX" --conditions=source "$LIMIT_HELPER" scan "$@" || stop "the scan failed."
  echo
  echo "Paste the lines above to Claude, with the output of --probe-limit if you ran it."
  exit 0
fi

# ---------------------------------------------------------------------------
# Probe-limit mode: one session while limited, every hook and the status line recorded.
# ---------------------------------------------------------------------------
if [[ "$MODE" == "probe-limit" ]]; then
  KEEP=0
  DRY_RUN=0
  CLAUDE_GIVEN=""
  FIXTURES=""
  START_TIMEOUT="${PROBE_START_TIMEOUT:-60}"
  TURN_TIMEOUT="${PROBE_TURN_TIMEOUT:-120}"
  STATUS_LINE_WAIT="${PROBE_STATUS_LINE_WAIT:-20}"
  while (($# > 0)); do
    case "$1" in
      --keep) KEEP=1 ;;
      --dry-run) DRY_RUN=1 ;;
      --model) MODEL="${2:?--model needs a value}"; shift ;;
      --claude)
        CLAUDE_GIVEN="$(cd "$(dirname "${2:?--claude needs a value}")" && pwd)/$(basename "$2")"
        PATH="$(dirname "$CLAUDE_GIVEN"):$PATH"
        shift
        ;;
      --fixtures) FIXTURES="${2:?--fixtures needs a value}"; shift ;;
      *) stop "unknown option $1 (see --help)" ;;
    esac
    shift
  done
  if ((DRY_RUN)); then
    guard_dry_run "$CLAUDE_GIVEN"
  else
    guard_owner_terminal
  fi
  for tool in claude tmux git node; do
    command -v "$tool" > /dev/null 2>&1 || stop "$tool is not installed or not in PATH."
  done
  [[ -x "$TSX" ]] || stop "the repository's packages are missing: run pnpm install in $REPO first."
  VERSION_TEXT="$(claude --version 2> /dev/null)" || stop "claude --version failed."
  VERSION="$(grep -oE '[0-9]+\.[0-9]+\.[0-9]+' <<< "$VERSION_TEXT" | head -n 1)"
  [[ -n "$VERSION" ]] || stop "cannot read the version in: $VERSION_TEXT"
  FIXTURES="${FIXTURES:-$REPO/apps/daemon/test/fixtures/usage-limit/claude-code-$VERSION}"

  if ((DRY_RUN == 0)); then
    echo "============================================================================"
    echo "USAGE-LIMIT CAPTURE: run it only while you are limited"
    echo "Claude Code must be showing you \"You've hit your ... limit\" right now (in"
    echo "your own Claude Code, or on claude.ai). This capture never tries to reach"
    echo "the limit."
    echo "============================================================================"
    guard_confirm "one session with one message (Reply with the word OK.) on $MODEL: refused at no cost while you are limited; a reply of a few tokens if the limit is over."
  fi

  SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/usage-limit-probe.XXXXXX")" || stop "cannot create the scratch folder."
  chmod 700 "$SCRATCH"
  TMUX_SOCKET="usage-limit-probe-$$"
  cleanup() {
    tmux -L "$TMUX_SOCKET" kill-server 2> /dev/null
    if ((KEEP)); then
      echo
      echo "Scratch folder kept (--keep): $SCRATCH"
      echo "It contains Claude credentials: delete it when you are done (rm -rf '$SCRATCH')."
    else
      rm -rf "$SCRATCH"
    fi
  }
  trap cleanup EXIT
  trap 'exit 3' INT TERM
  helper() {
    "$TSX" --conditions=source "$LIMIT_HELPER" "$@" --scratch "$SCRATCH"
  }
  CLAUDE_CONFIG="$SCRATCH/home/.orchestrator/claude-config"
  RECORD="$SCRATCH/record"
  echo "Usage-limit capture"
  echo "Claude Code:     $VERSION ($(command -v claude))"
  echo "Model:           $MODEL"
  echo "Scratch folder:  $SCRATCH (deleted at the end$( ((KEEP)) && echo ': no, --keep'))"
  echo "Claude config:   $CLAUDE_CONFIG (the capture's own; your ~/.claude is not used)"
  echo "Fixtures:        $FIXTURES (only if a limit is seen; never committed)"
  echo
  helper prepare || stop "the scratch layout could not be prepared."

  if ((DRY_RUN)); then
    echo "Dry run: no login."
  else
    echo "============================================================================"
    echo "LOG IN (this uses no quota)"
    echo "Claude Code now opens with the capture's own, empty configuration folder,"
    echo "exactly as 'orchestrator-daemon login' does for the daemon's folder."
    echo "  1. Go through the first screens and log in with your Claude account"
    echo "     (open the login link in your browser if asked). If Claude Code shows"
    echo "     its prompt without asking you to log in, type /login and press Enter."
    echo "  2. When you see the normal prompt, type /exit and press Enter."
    echo "Do not send any message."
    echo "============================================================================"
    read -r -p "Press Enter to open Claude Code..." _
    helper login
    [[ -f "$CLAUDE_CONFIG/.credentials.json" ]] ||
      stop "not logged in: $CLAUDE_CONFIG/.credentials.json is missing. Run the capture again and log in."
    echo "Logged in."
  fi
  echo

  hook_seen() { # event
    grep -q "\"event\":\"$1\"" "$RECORD/hooks-limit.jsonl" 2> /dev/null
  }
  echo "Session (one message on $MODEL)..."
  worktree="$SCRATCH/home/.orchestrator/worktrees/limit"
  mapfile -d '' args < <(helper session --model "$MODEL") ||
    stop "the session's files could not be written."
  printf -v command '%q ' env -u TMUX -u TMUX_PANE "CLAUDE_CONFIG_DIR=$CLAUDE_CONFIG" \
    GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never claude "${args[@]}"
  tmux -L "$TMUX_SOCKET" new-session -d -s limit -x 200 -y 50 -c "$worktree" \
    "$command; echo CLAUDE-EXITED; sleep 600" || stop "tmux could not start the session."
  waited=0
  while ! hook_seen SessionStart; do
    pane="$(tmux -L "$TMUX_SOCKET" capture-pane -p -t limit 2> /dev/null)"
    if grep -q CLAUDE-EXITED <<< "$pane" || ((waited >= START_TIMEOUT)); then
      echo "The session did not start. Its screen:" >&2
      echo "$pane" >&2
      stop "Claude Code did not start (dialog, login or argument problem): paste the screen above to Claude."
    fi
    sleep 1
    waited=$((waited + 1))
  done
  waited=0
  while ! hook_seen Stop && ! hook_seen StopFailure; do
    ((waited >= TURN_TIMEOUT)) && { echo "No end of turn after ${TURN_TIMEOUT}s: evaluating what was recorded."; break; }
    sleep 1
    waited=$((waited + 1))
  done
  # The status line runs when the screen refreshes; the screen may also offer an automatic
  # continue, which autoContinueAtUsageLimit: false must prevent.
  waited=0
  while ! grep -q rate_limits "$RECORD/status-line-limit.jsonl" 2> /dev/null && ((waited < STATUS_LINE_WAIT)); do
    sleep 1
    waited=$((waited + 1))
  done
  tmux -L "$TMUX_SOCKET" capture-pane -p -S -200 -t limit > "$SCRATCH/pane-limit.txt" 2> /dev/null
  tmux -L "$TMUX_SOCKET" send-keys -t limit -l '/exit' 2> /dev/null
  tmux -L "$TMUX_SOCKET" send-keys -t limit Enter 2> /dev/null
  waited=0
  while ! hook_seen SessionEnd && ((waited < 10)); do
    sleep 1
    waited=$((waited + 1))
  done
  tmux -L "$TMUX_SOCKET" kill-session -t limit 2> /dev/null

  echo
  echo "===== paste from here to Claude ====="
  helper evaluate --version "$VERSION" --model "$MODEL" --fixtures "$FIXTURES" | tee "$SCRATCH/results.txt"
  RESULT=${PIPESTATUS[0]}
  echo "===== to here ====="
  echo
  case "$RESULT" in
    0) echo "Limit captured. The fixtures are NOT committed: have them reviewed (paste the block above to Claude) before any commit." ;;
    2) echo "No limit was seen: nothing to capture. Run it again the next time Claude Code shows a limit." ;;
    *) echo "The capture could not be evaluated or the fixtures were withheld: paste the block above to Claude." ;;
  esac
  exit "$RESULT"
fi

# ---------------------------------------------------------------------------
# Standard and long runs: several real turns.
# ---------------------------------------------------------------------------
if [[ "$MODE" == "long" ]]; then
  guard_real "the spike's sessions on $MODEL: about 5 short turns, plus one after a session kept open 30 minutes."
else
  guard_real "the spike's sessions on $MODEL: about 5 short turns."
fi

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------
for dep in claude tmux node git; do
  command -v "$dep" >/dev/null 2>&1 || { echo "Missing dependency: $dep"; exit 1; }
done

WORK="$(mktemp -d "$HOME/orch-spike.XXXXXX")"
LOG="$WORK/logs"
# Runs happen in a subfolder of a root trusted once, as the daemon will do with its worktrees folder.
TRUST_ROOT="$WORK/trusted-root"
PROJ="$TRUST_ROOT/project"
mkdir -p "$LOG" "$PROJ"
echo "Working folder: $WORK"

git -C "$PROJ" init -q
echo "# spike" > "$PROJ/README.md"
git -C "$PROJ" -c user.name=spike -c user.email=spike@localhost add -A
git -C "$PROJ" -c user.name=spike -c user.email=spike@localhost commit -qm init

echo "Collecting Claude Code version and help outputs..."
timeout 20 claude --version < /dev/null > "$LOG/claude-version.txt" 2>&1
timeout 20 claude --help < /dev/null > "$LOG/help.txt" 2>&1
for sub in daemon logs remote-control; do
  # Some subcommands may start a process instead of printing help: never let them block the spike.
  echo "  claude $sub --help"
  timeout 15 claude "$sub" --help < /dev/null > "$LOG/help-$sub.txt" 2>&1
  rc=$?
  (( rc == 124 )) && echo "(timed out after 15 s: this subcommand does not print help and exit)" >> "$LOG/help-$sub.txt"
done

# Hook: logs every event; denies any Bash command containing "git push" (check 2)
cat > "$WORK/hook.js" << 'EOF'
const fs = require('fs');
const path = require('path');
const event = process.argv[2];
const logDir = process.argv[3];
let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(raw); } catch { input = { unparsed: raw }; }
  fs.appendFileSync(path.join(logDir, `${event}.jsonl`),
    JSON.stringify({ at: new Date().toISOString(), input }) + '\n');
  if (event === 'PreToolUse' && input.tool_name === 'Bash' &&
      String(input.tool_input?.command || '').includes('git push')) {
    const reason = 'SPIKE-DENY: pushing is done by the daemon, never by agents.';
    fs.appendFileSync(path.join(logDir, 'denied.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), command: input.tool_input.command }) + '\n');
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }));
  }
  process.exit(0);
});
EOF

# Minimal stdio MCP server with one tool (check 1)
cat > "$WORK/mcp.js" << 'EOF'
const fs = require('fs');
const path = require('path');
const logDir = process.argv[2];
const log = (o) => fs.appendFileSync(path.join(logDir, 'mcp.jsonl'),
  JSON.stringify({ at: new Date().toISOString(), ...o }) + '\n');
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    log({ received: msg.method });
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: {
        protocolVersion: msg.params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'spike', version: '0.1.0' } } });
    } else if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{
        name: 'ping',
        description: 'Spike test tool. Call it only when the user asks you to.',
        inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } }] } });
    } else if (msg.method === 'tools/call') {
      log({ call: msg.params });
      send({ jsonrpc: '2.0', id: msg.id, result: {
        content: [{ type: 'text', text: `pong: ${msg.params?.arguments?.message ?? ''}` }] } });
    } else if (msg.id !== undefined) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
    }
  }
});
EOF

cat > "$WORK/mcp.json" << EOF
{ "mcpServers": { "spike": { "command": "node", "args": ["$WORK/mcp.js", "$LOG"] } } }
EOF

HOOK_EVENTS=(SessionStart UserPromptSubmit PreToolUse PostToolUse Notification Stop SessionEnd)
node -e '
const [work, log, ...events] = process.argv.slice(1);
const hooks = {};
for (const e of events) {
  const entry = { hooks: [{ type: "command", command: `node ${work}/hook.js ${e} ${log}` }] };
  if (e === "PreToolUse" || e === "PostToolUse") entry.matcher = "*";
  hooks[e] = [entry];
}
const settings = { hooks, permissions: { allow: ["mcp__spike__ping", "Bash(echo:*)", "Read"] } };
require("fs").writeFileSync(`${work}/settings.json`, JSON.stringify(settings, null, 2));
' "$WORK" "$LOG" "${HOOK_EVENTS[@]}"

cat > "$WORK/system-prompt.md" << 'EOF'
You are running inside an automated test harness. Follow the user's steps exactly and keep every reply to one line.
Your secret spike marker is SPIKE-MARKER-7F3A. Give it only when asked for the spike marker.
EOF

cat > "$WORK/prompt1.txt" << 'EOF'
Automated test. Do exactly these steps in order, then stop. 1) Call the MCP tool ping from the spike server with message "hello". 2) Run this Bash command: echo spike > spike.txt 3) Run this Bash command: git push --dry-run origin main (it is expected to be blocked; do not retry and do not work around it). 4) Reply with one line: DONE followed by the exact reason you received for step 3.
EOF

printf 'Line one of a multi-line test.\nLine two.\nLine three: reply with the spike marker and the number of lines in this message.' > "$WORK/prompt2.txt"
echo 'Idle test: reply with the single word STILL-ALIVE.' > "$WORK/prompt3.txt"
echo 'Resume test: reply with the spike marker and the word RESUMED.' > "$WORK/prompt4.txt"

# Prefer the file flag for the appended system prompt; fall back to the text flag.
if grep -q -- '--append-system-prompt-file' "$LOG/help.txt"; then
  SP_ARGS="--append-system-prompt-file '$WORK/system-prompt.md'"
else
  SP_ARGS="--append-system-prompt \"\$(cat '$WORK/system-prompt.md')\""
fi
echo "$SP_ARGS" > "$LOG/system-prompt-flag.txt"

count() { [[ -f "$LOG/$1.jsonl" ]] && wc -l < "$LOG/$1.jsonl" || echo 0; }

TRUST_SEEN=0
wait_for() { # event, target count, timeout, tmux session
  local event="$1" target="$2" timeout="$3" session="$4" waited=0
  while (( waited < timeout )); do
    (( $(count "$event") >= target )) && return 0
    local pane
    pane="$(tmux capture-pane -p -S -200 -t "$session" 2>/dev/null || true)"
    if grep -q 'CLAUDE-EXITED' <<< "$pane"; then
      echo "$pane" > "$LOG/pane-exited.txt"
      echo "  Claude Code exited. Screen saved to logs/pane-exited.txt"
      return 1
    fi
    if (( TRUST_SEEN == 0 )) && grep -q 'Yes, I trust this folder' <<< "$pane"; then
      TRUST_SEEN=1
      echo "$pane" > "$LOG/pane-trust-dialog-subfolder.txt"
      echo "  Trust dialog shown again in the subfolder: accepting it to continue the other checks."
      accept_trust "$session"
    fi
    sleep 2; waited=$((waited + 2))
  done
  return 1
}

accept_trust() { # session — the default option is "No, exit": move down to "Yes" first
  tmux send-keys -t "$1" Down
  sleep 1
  tmux send-keys -t "$1" Enter
}

paste_text() { # session, file
  tmux load-buffer -b spike "$2"
  tmux paste-buffer -p -b spike -t "$1"
  sleep 1
  tmux send-keys -t "$1" Enter
}

S1="orch-spike-$$"
# --mcp-config accepts several values: it is placed first so the next option ends its list,
# and the prompt is always passed after "--" so it can never be read as an option value.
COMMON="claude --mcp-config '$WORK/mcp.json' --model '$MODEL' $SP_ARGS --settings '$WORK/settings.json'"

# ---------------------------------------------------------------------------
# Check 8: trust the root folder once, then see if subfolders inherit it
# ---------------------------------------------------------------------------
echo "Trust: opening Claude Code once in the root folder to accept the trust dialog..."
S0="orch-spike-trust-$$"
ROOT_TRUST_SHOWN=0
tmux new-session -d -s "$S0" -x 220 -y 50 -c "$TRUST_ROOT" "claude; echo CLAUDE-EXITED; sleep 600"
for _ in $(seq 1 15); do
  sleep 2
  pane="$(tmux capture-pane -p -t "$S0" 2>/dev/null || true)"
  if grep -q 'Yes, I trust this folder' <<< "$pane"; then
    ROOT_TRUST_SHOWN=1
    echo "$pane" > "$LOG/pane-trust-dialog-root.txt"
    accept_trust "$S0"
    sleep 5
    tmux capture-pane -p -t "$S0" > "$LOG/pane-after-root-trust.txt" 2>/dev/null
    break
  fi
done
tmux kill-session -t "$S0" 2>/dev/null
(( ROOT_TRUST_SHOWN )) && echo "  Root folder trusted." || echo "  No trust dialog in the root folder (see logs)."

# ---------------------------------------------------------------------------
# Turn 1: launch flags, MCP, allowlist, hook deny (checks 1, 2)
# ---------------------------------------------------------------------------
echo "Turn 1: starting an interactive session in tmux ($S1)..."
tmux new-session -d -s "$S1" -x 220 -y 50 -c "$PROJ" \
  "$COMMON -- \"\$(cat '$WORK/prompt1.txt')\"; echo CLAUDE-EXITED; sleep 3600"
tmux pipe-pane -t "$S1" -o "cat >> '$LOG/pane-raw.log'"

T1_OK=1
wait_for SessionStart 1 60 "$S1" || { T1_OK=0; echo "  No SessionStart hook after 60 s."; }
wait_for Stop 1 "$TURN_TIMEOUT" "$S1" || { T1_OK=0; echo "  Turn 1 did not finish (see pane capture)."; }
tmux capture-pane -p -t "$S1" > "$LOG/pane-after-turn1.txt" 2>/dev/null

# ---------------------------------------------------------------------------
# Turn 2: multi-line paste into an idle session (check 3)
# ---------------------------------------------------------------------------
T2_OK=0
if (( T1_OK )); then
  echo "Turn 2: pasting a multi-line message..."
  sleep 3
  paste_text "$S1" "$WORK/prompt2.txt"
  wait_for Stop 2 "$TURN_TIMEOUT" "$S1" && T2_OK=1
  tmux capture-pane -p -t "$S1" > "$LOG/pane-after-turn2.txt" 2>/dev/null
fi

# ---------------------------------------------------------------------------
# Optional: idle session for 30 minutes (check 6)
# ---------------------------------------------------------------------------
T3_STATUS="SKIPPED (run with --long)"
if [[ "$MODE" == "long" && $T2_OK -eq 1 ]]; then
  echo "Idle test: waiting 30 minutes before the next message..."
  sleep 1800
  paste_text "$S1" "$WORK/prompt3.txt"
  if wait_for Stop 3 "$TURN_TIMEOUT" "$S1"; then T3_STATUS="PASS"; else T3_STATUS="FAIL"; fi
  tmux capture-pane -p -t "$S1" > "$LOG/pane-after-idle.txt" 2>/dev/null
fi

# ---------------------------------------------------------------------------
# Resume: close the session, resume it by id in a new tmux session (check 1)
# ---------------------------------------------------------------------------
SID="$(node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n");console.log(JSON.parse(l[0]).input.session_id||"")' "$LOG/SessionStart.jsonl" 2>/dev/null)"
tmux kill-session -t "$S1" 2>/dev/null
R_OK=0
if [[ -n "$SID" ]]; then
  echo "Resume: resuming session $SID..."
  S2="orch-spike-resume-$$"
  BEFORE_STOP="$(count Stop)"
  tmux new-session -d -s "$S2" -x 220 -y 50 -c "$PROJ" \
    "$COMMON --resume '$SID' -- \"\$(cat '$WORK/prompt4.txt')\"; echo CLAUDE-EXITED; sleep 3600"
  wait_for Stop $((BEFORE_STOP + 1)) "$TURN_TIMEOUT" "$S2" && R_OK=1
  tmux capture-pane -p -t "$S2" > "$LOG/pane-after-resume.txt" 2>/dev/null
  tmux kill-session -t "$S2" 2>/dev/null
fi

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
node - "$WORK" "$T1_OK" "$T2_OK" "$T3_STATUS" "$R_OK" "$TRUST_SEEN" "$SID" "$ROOT_TRUST_SHOWN" << 'EOF'
const fs = require('fs');
const path = require('path');
const [work, t1, t2, t3, r, trust, sid, rootTrust] = process.argv.slice(2);
const log = path.join(work, 'logs');
const read = (f) => { try { return fs.readFileSync(path.join(log, f), 'utf8'); } catch { return ''; } };
const jsonl = (f) => read(f).trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const help = read('help.txt');
const flags = ['--append-system-prompt-file', '--append-system-prompt', '--settings', '--mcp-config',
  '--strict-mcp-config', '--model', '--resume', '--session-id', '--permission-mode'];

const starts = jsonl('SessionStart.jsonl');
const prompts = jsonl('UserPromptSubmit.jsonl');
const pre = jsonl('PreToolUse.jsonl');
const stops = jsonl('Stop.jsonl');
const notifs = jsonl('Notification.jsonl');
const denied = jsonl('denied.jsonl');
const mcpCalls = jsonl('mcp.jsonl').filter((e) => e.call);
const spikeFile = fs.existsSync(path.join(work, 'trusted-root', 'project', 'spike.txt'));

const transcriptPath = starts[0]?.input?.transcript_path;
let transcript = '';
try { transcript = fs.readFileSync(transcriptPath, 'utf8'); } catch {}
const entries = transcript.trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const types = {};
for (const e of entries) {
  const k = `${e.type ?? '?'}${e.message?.role ? '/' + e.message.role : ''}`;
  types[k] ??= new Set();
  Object.keys(e).forEach((key) => types[k].add(key));
}
const markerSeen = transcript.includes('7F3A');
const denyReasonSeen = transcript.includes('SPIKE-DENY');

const multiLine = prompts.map((p) => String(p.input.prompt ?? ''));
const pastedAsOne = multiLine.some((p) => p.includes('Line one') && p.includes('Line three'));
const pastedSplit = multiLine.filter((p) => /Line (one|two|three)/.test(p)).length > 1;

const status = (ok) => (ok ? 'PASS' : 'FAIL');
const rows = [
  ['1a', 'Interactive session starts with model, appended prompt, settings, MCP config, initial prompt', status(t1 === '1')],
  ['1b', 'Appended system prompt is applied (marker returned)', status(markerSeen)],
  ['1c', 'MCP server from --mcp-config is called without approval prompt', status(mcpCalls.length > 0)],
  ['1d', 'Allowlisted Bash command runs without prompt (spike.txt created)', status(spikeFile)],
  ['1e', 'Session resumes by id with --resume', status(r === '1')],
  ['2a', 'SessionStart hook gives session_id and transcript_path', status(!!starts[0]?.input?.session_id && !!transcriptPath)],
  ['2b', 'Stop hook fires at the end of each turn (not only at session end)', status(stops.length >= 2)],
  ['2c', 'PreToolUse hook can deny a tool with a reason the agent reads', status(denied.length > 0 && denyReasonSeen)],
  ['3', 'Multi-line paste through tmux arrives as a single message', pastedAsOne && !pastedSplit ? 'PASS' : 'FAIL'],
  ['4', 'Usage-limit signal', 'MANUAL: run --scan-limit after hitting the limit'],
  ['5', 'Transcript format (see structure below; compare across versions)', entries.length ? 'CHECK' : 'FAIL'],
  ['6', 'Idle session usable after 30 minutes', t3],
  ['7', 'Native background session features (see help outputs)', 'MANUAL: review logs/help-*.txt'],
  ['8a', 'Trust dialog shown in a new root folder', rootTrust === '1' ? 'SHOWN (accepted)' : 'NOT SHOWN'],
  ['8b', 'Subfolder of a trusted root runs without a new trust dialog', trust === '1' ? 'FAIL (dialog shown again)' : 'PASS'],
];

let md = `# Claude Code spike report\n\n`;
md += `- Date: ${new Date().toISOString()}\n- Claude Code: ${read('claude-version.txt').trim()}\n`;
md += `- System prompt flag used: \`${read('system-prompt-flag.txt').trim()}\`\n- Session id: ${sid || 'none'}\n\n`;
md += `## Results\n\n| Check | Description | Result |\n|---|---|---|\n`;
rows.forEach(([c, d, s]) => (md += `| ${c} | ${d} | ${s} |\n`));
md += `\n## Flags listed in \`claude --help\`\n\n`;
flags.forEach((f) => (md += `- \`${f}\`: ${help.includes(f) ? 'listed' : 'not listed (may still exist)'}\n`));
md += `\n## Hook events received\n\n`;
md += `- SessionStart: ${starts.length} (sources: ${starts.map((s) => s.input.source).join(', ') || 'n/a'}; ids: ${[...new Set(starts.map((s) => s.input.session_id))].join(', ')})\n`;
md += `- UserPromptSubmit: ${prompts.length}\n- PreToolUse: ${pre.length} (tools: ${[...new Set(pre.map((p) => p.input.tool_name))].join(', ')})\n`;
md += `- Stop: ${stops.length}\n- Notification: ${notifs.length}${notifs.length ? ' — ' + notifs.map((n) => JSON.stringify(n.input.message ?? n.input)).join('; ') : ''}\n`;
md += `\n## SessionStart payload keys\n\n\`${Object.keys(starts[0]?.input ?? {}).join('`, `')}\`\n`;
md += `\n## Stop payload keys\n\n\`${Object.keys(stops[0]?.input ?? {}).join('`, `')}\`\n`;
md += `\n## Transcript structure\n\nFile: \`${transcriptPath ?? 'unknown'}\` — ${entries.length} entries\n\n| Entry type | Keys |\n|---|---|\n`;
Object.entries(types).forEach(([t, keys]) => (md += `| ${t} | ${[...keys].join(', ')} |\n`));
md += `\n## Check 4 — usage limit\n\n_Paste the output of \`--scan-limit\` here after hitting the limit._\n`;
md += `\n## Notes\n\n_Anything observed manually (pane captures in logs/, help outputs for check 7)._\n`;
fs.writeFileSync(path.join(work, 'spike-report.md'), md);
console.log(md);
EOF

echo
echo "Report: $WORK/spike-report.md"
echo "Logs:   $LOG"

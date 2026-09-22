#!/usr/bin/env bash
# Claude Code spike — verifies the assumptions listed in docs/specs/05-daemon.md, section 9.
#
# Usage:
#   ./claude-code-spike.sh              Standard run (about 5 minutes, a few short Sonnet turns)
#   ./claude-code-spike.sh --long       Also tests an idle session kept open for 30 minutes
#   ./claude-code-spike.sh --scan-limit Search existing transcripts for usage-limit messages
#                                       (run it right after you hit your usage limit for real)
#
# Requirements: claude (logged in), tmux, node, git.
# Output: a working folder under ~/orch-spike.XXXXXX with logs and spike-report.md.

set -uo pipefail

MODE="standard"
case "${1:-}" in
  --long) MODE="long" ;;
  --scan-limit) MODE="scan" ;;
  "") ;;
  *) echo "Unknown option: $1"; exit 1 ;;
esac

MODEL="${SPIKE_MODEL:-sonnet}"
TURN_TIMEOUT="${SPIKE_TURN_TIMEOUT:-240}"

# ---------------------------------------------------------------------------
# Scan mode: look for usage-limit traces in existing transcripts (check 4)
# ---------------------------------------------------------------------------
if [[ "$MODE" == "scan" ]]; then
  echo "Scanning ~/.claude/projects for usage-limit messages (most recent files first)..."
  find "$HOME/.claude/projects" -name '*.jsonl' -mtime -2 -printf '%T@ %p\n' 2>/dev/null \
    | sort -rn | cut -d' ' -f2- | head -50 \
    | xargs -r grep -n -i -E 'usage limit|limit reached|rate.?limit|resets? (at|in)|hit your limit' 2>/dev/null \
    | cut -c1-600
  echo
  echo "Copy the relevant lines above into the report, section 'Check 4'."
  exit 0
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

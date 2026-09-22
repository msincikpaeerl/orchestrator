#!/usr/bin/env bash
# Claude Code spike v2 — follow-up checks after the first spike report.
#
#   8c  Trust survives when a slot folder is emptied and reused by a DIFFERENT repository (git worktree)
#   9   --permission-mode dontAsk refuses non-allowed tools without showing a permission prompt
#   6   An interactive session left idle (default 30 minutes) still answers
#   10  Usage estimate (cost-state entry) readable from the transcript
#
# Usage:
#   ./claude-code-spike-v2.sh                 Full run (about 35 minutes, mostly waiting)
#   SPIKE_IDLE_MINUTES=1 ./claude-code-spike-v2.sh   Quick run with a short idle test
#
# Requirements: claude (logged in), tmux, node, git.

set -uo pipefail

MODEL="${SPIKE_MODEL:-sonnet}"
TURN_TIMEOUT="${SPIKE_TURN_TIMEOUT:-240}"
IDLE_MINUTES="${SPIKE_IDLE_MINUTES:-30}"

for dep in claude tmux node git; do
  command -v "$dep" >/dev/null 2>&1 || { echo "Missing dependency: $dep"; exit 1; }
done

WORK="$(mktemp -d "$HOME/orch-spike2.XXXXXX")"
LOG="$WORK/logs"
SLOT="$WORK/slots/slot-1"
mkdir -p "$LOG" "$WORK/slots"
echo "Working folder: $WORK"
timeout 20 claude --version < /dev/null > "$LOG/claude-version.txt" 2>&1

GIT="git -c user.name=spike -c user.email=spike@localhost"

# Two unrelated repositories, as bare clones (like the daemon's cache)
for name in A B; do
  src="$WORK/src-$name"
  mkdir -p "$src"
  $GIT -C "$src" init -q -b main
  echo "# Repository $name" > "$src/README.md"
  $GIT -C "$src" add -A
  $GIT -C "$src" commit -qm "init $name"
  git clone -q --bare "$src" "$WORK/$name.git"
done

# Logging hook
cat > "$WORK/hook.js" << 'EOF'
const fs = require('fs');
const path = require('path');
const [event, logDir] = process.argv.slice(2);
let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(raw); } catch { input = { unparsed: raw }; }
  fs.appendFileSync(path.join(logDir, `${event}.jsonl`),
    JSON.stringify({ at: new Date().toISOString(), input }) + '\n');
  process.exit(0);
});
EOF

node -e '
const [work, log] = process.argv.slice(1);
const hooks = {};
for (const e of ["SessionStart", "UserPromptSubmit", "PreToolUse", "Notification", "Stop"]) {
  const entry = { hooks: [{ type: "command", command: `node ${work}/hook.js ${e} ${log}` }] };
  if (e === "PreToolUse") entry.matcher = "*";
  hooks[e] = [entry];
}
const settings = { hooks, permissions: { allow: ["Bash(echo:*)", "ToolSearch", "Read"] } };
require("fs").writeFileSync(`${work}/settings.json`, JSON.stringify(settings, null, 2));
' "$WORK" "$LOG"

cat > "$WORK/prompt1.txt" << 'EOF'
Automated test. Do exactly these steps, then stop. 1) Run this Bash command: touch forbidden.txt 2) Run this Bash command: echo allowed > allowed.txt 3) Reply with one line: DONE, then say for each step whether it ran or was refused, and quote any refusal message you received.
EOF
echo 'Idle test: reply with the single word STILL-ALIVE.' > "$WORK/prompt2.txt"

count() { [[ -f "$LOG/$1.jsonl" ]] && wc -l < "$LOG/$1.jsonl" || echo 0; }

accept_trust() { tmux send-keys -t "$1" Down; sleep 1; tmux send-keys -t "$1" Enter; }

TRUST_AGAIN=0
PROMPT_SEEN=0
wait_for() { # event, target, timeout, session
  local event="$1" target="$2" timeout="$3" session="$4" waited=0 pane
  while (( waited < timeout )); do
    (( $(count "$event") >= target )) && return 0
    pane="$(tmux capture-pane -p -S -200 -t "$session" 2>/dev/null || true)"
    if grep -q 'CLAUDE-EXITED' <<< "$pane"; then
      echo "$pane" > "$LOG/pane-exited.txt"; echo "  Claude Code exited (logs/pane-exited.txt)."; return 1
    fi
    if (( TRUST_AGAIN == 0 )) && grep -q 'Yes, I trust this folder' <<< "$pane"; then
      TRUST_AGAIN=1
      echo "$pane" > "$LOG/pane-trust-again.txt"
      echo "  Trust dialog shown again: accepting it to continue the other checks."
      accept_trust "$session"
    fi
    if (( PROMPT_SEEN == 0 )) && grep -qE 'Do you want to|Allow this|allow once' <<< "$pane"; then
      PROMPT_SEEN=1
      echo "$pane" > "$LOG/pane-permission-prompt.txt"
      echo "  Permission prompt shown: refusing it with Escape to continue."
      tmux send-keys -t "$session" Escape
    fi
    sleep 2; waited=$((waited + 2))
  done
  return 1
}

paste_text() {
  tmux load-buffer -b spike "$2"; tmux paste-buffer -p -b spike -t "$1"; sleep 1; tmux send-keys -t "$1" Enter
}

# ---------------------------------------------------------------------------
# Round 1: slot holds a worktree of repository A; trust it once
# ---------------------------------------------------------------------------
echo "Round 1: worktree of repository A in the slot, accepting trust once..."
git -C "$WORK/A.git" worktree add -q -b t/1 "$SLOT" main
S0="orch-spike2-trust-$$"
ROOT_TRUST=0
tmux new-session -d -s "$S0" -x 220 -y 50 -c "$SLOT" "claude; echo CLAUDE-EXITED; sleep 600"
for _ in $(seq 1 15); do
  sleep 2
  if tmux capture-pane -p -t "$S0" 2>/dev/null | grep -q 'Yes, I trust this folder'; then
    ROOT_TRUST=1; accept_trust "$S0"; sleep 5; break
  fi
done
tmux kill-session -t "$S0" 2>/dev/null
(( ROOT_TRUST )) && echo "  Slot trusted." || echo "  No trust dialog shown in round 1."

# ---------------------------------------------------------------------------
# Round 2: empty the slot, put a worktree of repository B at the same path
# ---------------------------------------------------------------------------
echo "Round 2: replacing the slot content with a worktree of repository B..."
git -C "$WORK/A.git" worktree remove --force "$SLOT"
[[ -e "$SLOT" ]] && rm -rf "$SLOT"
git -C "$WORK/B.git" worktree add -q -b t/2 "$SLOT" main
SLOT_REPO="$(head -1 "$SLOT/README.md")"

S1="orch-spike2-$$"
tmux new-session -d -s "$S1" -x 220 -y 50 -c "$SLOT" \
  "claude --settings '$WORK/settings.json' --permission-mode dontAsk --model '$MODEL' -- \"\$(cat '$WORK/prompt1.txt')\"; echo CLAUDE-EXITED; sleep 7200"

T1_OK=0
echo "Turn 1: dontAsk test..."
wait_for SessionStart 1 60 "$S1" && wait_for Stop 1 "$TURN_TIMEOUT" "$S1" && T1_OK=1
tmux capture-pane -p -S -200 -t "$S1" > "$LOG/pane-after-turn1.txt" 2>/dev/null

# ---------------------------------------------------------------------------
# Idle test
# ---------------------------------------------------------------------------
IDLE_OK=0
if (( T1_OK )); then
  echo "Idle test: waiting $IDLE_MINUTES minute(s) before the next message (started $(date +%H:%M))..."
  sleep $((IDLE_MINUTES * 60))
  paste_text "$S1" "$WORK/prompt2.txt"
  wait_for Stop 2 "$TURN_TIMEOUT" "$S1" && IDLE_OK=1
  tmux capture-pane -p -S -200 -t "$S1" > "$LOG/pane-after-idle.txt" 2>/dev/null
fi
tmux kill-session -t "$S1" 2>/dev/null

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
node - "$WORK" "$SLOT" "$ROOT_TRUST" "$TRUST_AGAIN" "$PROMPT_SEEN" "$T1_OK" "$IDLE_OK" "$IDLE_MINUTES" "$SLOT_REPO" << 'EOF'
const fs = require('fs');
const path = require('path');
const [work, slot, rootTrust, trustAgain, promptSeen, t1, idle, idleMin, slotRepo] = process.argv.slice(2);
const log = path.join(work, 'logs');
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const jsonl = (f) => read(path.join(log, f)).trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const starts = jsonl('SessionStart.jsonl');
const stops = jsonl('Stop.jsonl');
const notifs = jsonl('Notification.jsonl');
const pre = jsonl('PreToolUse.jsonl');
const transcriptPath = starts[0]?.input?.transcript_path;
const entries = read(transcriptPath).trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const forbidden = fs.existsSync(path.join(slot, 'forbidden.txt'));
const allowed = fs.existsSync(path.join(slot, 'allowed.txt'));
const denials = entries.filter((e) => e.toolDenialKind).map((e) => e.toolDenialKind);
const costs = entries.filter((e) => e.type === 'cost-state');
const lastCost = costs[costs.length - 1];
const lastMessage = stops[0]?.input?.last_assistant_message;

const rows = [
  ['8c-1', 'Trust dialog shown the first time in the slot (round 1)', rootTrust === '1' ? 'SHOWN (accepted)' : 'NOT SHOWN'],
  ['8c-2', `Slot reused by another repository (${slotRepo}) starts without trust dialog`, trustAgain === '1' ? 'FAIL (dialog shown again)' : (starts.length ? 'PASS' : 'FAIL (session did not start)')],
  ['9-1', 'dontAsk: turn completes with no permission prompt', t1 === '1' && promptSeen !== '1' ? 'PASS' : 'FAIL'],
  ['9-2', 'dontAsk: non-allowed command was not executed (forbidden.txt absent)', forbidden ? 'FAIL' : 'PASS'],
  ['9-3', 'dontAsk: allowed command was executed (allowed.txt present)', allowed ? 'PASS' : 'FAIL'],
  ['6', `Idle session answers after ${idleMin} minute(s)`, idle === '1' ? 'PASS' : 'FAIL'],
  ['10', 'Usage estimate available in transcript (cost-state)', lastCost ? 'PASS' : 'FAIL'],
];

let md = `# Claude Code spike v2 report\n\n- Date: ${new Date().toISOString()}\n- Claude Code: ${read(path.join(log, 'claude-version.txt')).trim()}\n\n`;
md += `## Results\n\n| Check | Description | Result |\n|---|---|---|\n`;
rows.forEach(([c, d, s]) => (md += `| ${c} | ${d} | ${s} |\n`));
md += `\n## Details\n\n`;
md += `- Notifications received: ${notifs.length}${notifs.length ? ' — ' + notifs.map((n) => JSON.stringify(n.input.message ?? n.input)).join('; ') : ''}\n`;
md += `- Tools seen in PreToolUse: ${[...new Set(pre.map((p) => p.input.tool_name))].join(', ') || 'none'}\n`;
md += `- Permission mode reported by Stop hook: ${stops[0]?.input?.permission_mode ?? 'n/a'}\n`;
md += `- Tool denial kinds in transcript: ${denials.length ? [...new Set(denials)].join(', ') : 'none'}\n`;
md += `- Agent's own report of turn 1: ${lastMessage ? JSON.stringify(lastMessage).slice(0, 600) : 'n/a'}\n`;
if (lastCost) {
  md += `\n## Usage estimate (last cost-state entry)\n\n\`\`\`json\n${JSON.stringify({
    totalCostUSD: lastCost.totalCostUSD, totalDuration: lastCost.totalDuration,
    totalAPIDuration: lastCost.totalAPIDuration, modelUsage: lastCost.modelUsage }, null, 2)}\n\`\`\`\n`;
}
md += `\n## Notes\n\n_Pane captures are in logs/. If 9-1 failed, see logs/pane-permission-prompt.txt._\n`;
fs.writeFileSync(path.join(work, 'spike-v2-report.md'), md);
console.log(md);
EOF

echo
echo "Report: $WORK/spike-v2-report.md"

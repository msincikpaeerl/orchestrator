#!/usr/bin/env bash
# Claude Code spike v3 — workspace trust for daemon-managed worktrees.
#
# Finding from v2: trust for a git worktree is stored under the path of the MAIN repository
# (the bare clone), not the worktree path. This spike checks that the daemon can:
#
#   11a  run agents with a dedicated Claude config folder (CLAUDE_CONFIG_DIR), logged in separately
#   11b  pre-seed trust for a repository and start a worktree session with no trust dialog
#   11c  start a second worktree of the same repository (different path) with no dialog
#   11d  keep the owner's personal ~/.claude.json untouched
#   11e  write transcripts under the dedicated config folder
#
# Usage: ./claude-code-spike-v3.sh
# One manual step at the start: log in to Claude in the dedicated config folder (browser login).

set -uo pipefail

MODEL="${SPIKE_MODEL:-sonnet}"
TURN_TIMEOUT="${SPIKE_TURN_TIMEOUT:-180}"

for dep in claude tmux node git; do
  command -v "$dep" >/dev/null 2>&1 || { echo "Missing dependency: $dep"; exit 1; }
done

WORK="$(mktemp -d "$HOME/orch-spike3.XXXXXX")"
LOG="$WORK/logs"
CFG="$WORK/claude-config"
mkdir -p "$LOG" "$CFG" "$WORK/login" "$WORK/worktrees"
echo "Working folder: $WORK"
echo "Dedicated Claude config folder: $CFG"

USER_CFG="$HOME/.claude.json"
user_cfg_has_repo() { node -e 'try{const c=require(process.argv[1]);process.stdout.write(Object.keys(c.projects||{}).some(k=>k.includes(process.argv[2]))?"yes":"no")}catch{process.stdout.write("no")}' "$USER_CFG" "$1"; }

# ---------------------------------------------------------------------------
# Manual step: log in with the dedicated config folder
# ---------------------------------------------------------------------------
cat << EOF

============================================================================
MANUAL STEP
Claude Code will now open with an EMPTY config folder (as the daemon will).
  1. Go through the first-run screens and log in with your Claude account
     (same subscription; open the login link in your browser if asked).
  2. Accept the trust dialog for the 'login' folder if it appears.
  3. When you reach the normal prompt, type /exit and press Enter.
Do not send any message: it would use quota for nothing.
============================================================================
EOF
read -r -p "Press Enter to open Claude Code..." _
( cd "$WORK/login" && CLAUDE_CONFIG_DIR="$CFG" claude )
echo

CFG_FILE="$CFG/.claude.json"
if [[ ! -f "$CFG_FILE" ]]; then
  echo "No $CFG_FILE found. Files in the config folder:"; ls -la "$CFG"
  echo "Cannot continue: the dedicated config file was not created where expected."
  exit 1
fi
ls -la "$CFG" > "$LOG/config-folder.txt"

# ---------------------------------------------------------------------------
# Repository C (bare clone) and two worktrees at different paths
# ---------------------------------------------------------------------------
GIT="git -c user.name=spike -c user.email=spike@localhost"
mkdir -p "$WORK/src-C"
$GIT -C "$WORK/src-C" init -q -b main
echo "# Repository C" > "$WORK/src-C/README.md"
$GIT -C "$WORK/src-C" add -A && $GIT -C "$WORK/src-C" commit -qm init
git clone -q --bare "$WORK/src-C" "$WORK/C.git"
REPO="$WORK/C.git"
git -C "$REPO" worktree add -q -b t/1 "$WORK/worktrees/run-1" main
git -C "$REPO" worktree add -q -b t/2 "$WORK/worktrees/run-2" main

# ---------------------------------------------------------------------------
# Pre-seed trust for the repository in the dedicated config (atomic write)
# ---------------------------------------------------------------------------
node -e '
const fs = require("fs");
const [file, repo] = process.argv.slice(1);
const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
cfg.projects ??= {};
cfg.projects[repo] = { ...(cfg.projects[repo] || {}), hasTrustDialogAccepted: true };
const tmp = `${file}.tmp-${process.pid}`;
fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
fs.renameSync(tmp, file);
' "$CFG_FILE" "$REPO"
echo "Trust pre-seeded for $REPO"

# Hooks
cat > "$WORK/hook.js" << 'EOF'
const fs = require('fs');
const path = require('path');
const [event, logDir, tag] = process.argv.slice(2);
let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(raw); } catch { input = { unparsed: raw }; }
  fs.appendFileSync(path.join(logDir, `${tag}-${event}.jsonl`), JSON.stringify({ at: new Date().toISOString(), input }) + '\n');
  process.exit(0);
});
EOF

make_settings() { # tag
  node -e '
const [work, log, tag] = process.argv.slice(1);
const hooks = {};
for (const e of ["SessionStart", "Stop"]) hooks[e] = [{ hooks: [{ type: "command", command: `node ${work}/hook.js ${e} ${log} ${tag}` }] }];
require("fs").writeFileSync(`${work}/settings-${tag}.json`, JSON.stringify({ hooks, permissions: { allow: ["ToolSearch", "Read"] } }, null, 2));
' "$WORK" "$LOG" "$1"
}

count() { [[ -f "$LOG/$1.jsonl" ]] && wc -l < "$LOG/$1.jsonl" || echo 0; }

# Runs one short session; never answers a dialog: any dialog before SessionStart is a failure.
run_session() { # tag, worktree
  local tag="$1" wt="$2" session="orch-spike3-$1-$$" waited=0 pane result="FAIL (no SessionStart)"
  make_settings "$tag"
  tmux new-session -d -s "$session" -x 220 -y 50 -c "$wt" \
    "CLAUDE_CONFIG_DIR='$CFG' claude --settings '$WORK/settings-$tag.json' --permission-mode dontAsk --model '$MODEL' -- 'Reply with the single word READY.'; echo CLAUDE-EXITED; sleep 600"
  while (( waited < 60 )); do
    if (( $(count "$tag-SessionStart") >= 1 )); then result="PASS"; break; fi
    pane="$(tmux capture-pane -p -S -100 -t "$session" 2>/dev/null || true)"
    if grep -qE 'trust this folder|Enter to confirm' <<< "$pane"; then
      echo "$pane" > "$LOG/pane-$tag-dialog.txt"; result="FAIL (dialog shown, see logs/pane-$tag-dialog.txt)"; break
    fi
    if grep -q 'CLAUDE-EXITED' <<< "$pane"; then
      echo "$pane" > "$LOG/pane-$tag-exited.txt"; result="FAIL (exited, see logs/pane-$tag-exited.txt)"; break
    fi
    sleep 2; waited=$((waited + 2))
  done
  if [[ "$result" == "PASS" ]]; then
    waited=0
    while (( waited < TURN_TIMEOUT )) && (( $(count "$tag-Stop") < 1 )); do sleep 2; waited=$((waited + 2)); done
  fi
  tmux capture-pane -p -S -100 -t "$session" > "$LOG/pane-$tag-final.txt" 2>/dev/null
  tmux kill-session -t "$session" 2>/dev/null
  echo "$result"
}

echo "Session 1: first worktree (run-1)..."
R1="$(run_session run1 "$WORK/worktrees/run-1" | tail -1)"; echo "  $R1"
echo "Session 2: second worktree of the same repository (run-2)..."
R2="$(run_session run2 "$WORK/worktrees/run-2" | tail -1)"; echo "  $R2"

USER_TOUCHED="$(user_cfg_has_repo "orch-spike3")"

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
node - "$WORK" "$CFG" "$CFG_FILE" "$REPO" "$R1" "$R2" "$USER_TOUCHED" << 'EOF'
const fs = require('fs');
const path = require('path');
const [work, cfgDir, cfgFile, repo, r1, r2, userTouched] = process.argv.slice(2);
const log = path.join(work, 'logs');
const first = (f) => { try { return JSON.parse(fs.readFileSync(path.join(log, f), 'utf8').split('\n')[0]); } catch { return null; } };
const s1 = first('run1-SessionStart.jsonl');
const s2 = first('run2-SessionStart.jsonl');
const stop1 = first('run1-Stop.jsonl');
let trustKeys = [];
try {
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  trustKeys = Object.entries(cfg.projects || {}).map(([k, v]) => `${k} -> ${v.hasTrustDialogAccepted}`);
} catch {}
const tp = s1?.input?.transcript_path || '';
const rows = [
  ['11a', 'Dedicated config folder created and logged in', fs.existsSync(cfgFile) ? 'PASS' : 'FAIL'],
  ['11b', 'Worktree session starts with pre-seeded repository trust, no dialog', r1],
  ['11c', 'Second worktree (other path, same repository) starts with no dialog', r2],
  ['11d', "Owner's ~/.claude.json has no entry for this spike", userTouched === 'no' ? 'PASS' : 'FAIL'],
  ['11e', 'Transcript written under the dedicated config folder', tp.startsWith(cfgDir) ? 'PASS' : `FAIL (${tp || 'no transcript path'})`],
];
let md = `# Claude Code spike v3 report\n\n- Date: ${new Date().toISOString()}\n- Repository (bare clone): \`${repo}\`\n- Config folder: \`${cfgDir}\`\n\n`;
md += `## Results\n\n| Check | Description | Result |\n|---|---|---|\n`;
rows.forEach(([c, d, s]) => (md += `| ${c} | ${d} | ${s} |\n`));
md += `\n## Trust entries in the dedicated config\n\n${trustKeys.map((k) => `- \`${k}\``).join('\n') || '_none_'}\n`;
md += `\n## Session 1\n\n- Transcript: \`${tp}\`\n- Final message: ${JSON.stringify(stop1?.input?.last_assistant_message ?? 'n/a')}\n`;
md += `\n## Session 2\n\n- Session id: ${s2?.input?.session_id ?? 'n/a'}\n`;
fs.writeFileSync(path.join(work, 'spike-v3-report.md'), md);
console.log(md);
EOF

echo
echo "Report: $WORK/spike-v3-report.md"
echo "You can delete the whole working folder afterwards, including its separate Claude login: rm -rf $WORK"

#!/usr/bin/env bash
# Claude Code probe (lot 2 plan, step H): checks, with the real Claude Code, the documented
# behaviour the daemon relies on. For the owner only (working rule 10): sessions never run it.
#
#   1. --setting-sources user: the repository's .claude/settings.json (allow rule, hook) is ignored
#   2. --strict-mcp-config: the repository's .mcp.json server is not started or offered
#   3. a deny rule refuses `cat` on the daemon's folder, with the rule's own message (a control file
#      next to it, which no rule covers, is read or refused by dontAsk mode)
#   4. the status line input has rate_limits and cost
#   5. INFO: no settings problem is reported for autoContinueAtUsageLimit (Claude Code does not
#      report unknown keys either, which a control session with a made-up key shows; only the
#      usage-limit capture proves the key)
#
# Everything lives in a scratch folder under the temporary folder, with a Claude configuration
# folder of its own: your ~/.claude and ~/.claude.json are never read or changed. The settings,
# the argument list, the login and the trust entry come from the daemon's own code
# (apps/daemon/scripts/claude-code-probe.ts). Quota: one session with one short prompt on the
# smallest model; the control session sends no prompt. It refuses to run in CI or without a
# terminal, and asks you to type yes before any session.
#
# Usage: tools/smoke/claude-code-probe.sh [--keep] [--model <alias>] [--claude <executable>]
#                                         [--fixtures <folder>] [--dry-run]
#   --keep       keep the scratch folder (it holds Claude credentials: delete it yourself)
#   --model      model alias (default: haiku, the smallest)
#   --claude     the claude executable to use (default: claude from PATH)
#   --fixtures   where the fixtures go (default: apps/daemon/test/fixtures/claude-code-<version>)
#   --dry-run    skip the login; only with the tests' fake claude given with --claude
#
# The fixtures keep only the transcript entries the daemon reads, with paths, e-mail addresses and
# credentials masked; if your e-mail, Git user, organisation id or home folder still appears in
# them, nothing is written.
#
# Exit code: 0 when every check passes (or is INFO), 1 when one fails, 2 when an action was not
# attempted, 3 when the probe could not run or the fixtures were not written.

set -uo pipefail

KEEP=0
DRY_RUN=0
CLAUDE_GIVEN=""
MODEL=haiku
FIXTURES=""
START_TIMEOUT="${PROBE_START_TIMEOUT:-60}"
TURN_TIMEOUT="${PROBE_TURN_TIMEOUT:-180}"
STATUS_LINE_WAIT="${PROBE_STATUS_LINE_WAIT:-20}"
SETTLE="${PROBE_SETTLE:-5}"

stop() {
  echo "STOPPED: $*" >&2
  exit 3
}

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
    -h | --help) sed -n '2,34p' "$0"; exit 0 ;;
    *) stop "unknown option $1 (see --help)" ;;
  esac
  shift
done

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=lib/real-claude-guard.sh
source "$REPO/tools/smoke/lib/real-claude-guard.sh"
if ((DRY_RUN)); then
  guard_dry_run "$CLAUDE_GIVEN"
else
  guard_real "a control session with no message (no quota), then one session with one short prompt on $MODEL (about 4 tool calls)."
fi
TSX="$REPO/apps/daemon/node_modules/.bin/tsx"
HELPER="$REPO/apps/daemon/scripts/claude-code-probe.ts"

for tool in claude tmux git node; do
  command -v "$tool" > /dev/null 2>&1 || stop "$tool is not installed or not in PATH."
done
[[ -x "$TSX" ]] || stop "the repository's packages are missing: run pnpm install in $REPO first."

VERSION_TEXT="$(claude --version 2> /dev/null)" || stop "claude --version failed."
VERSION="$(grep -oE '[0-9]+\.[0-9]+\.[0-9]+' <<< "$VERSION_TEXT" | head -n 1)"
[[ -n "$VERSION" ]] || stop "cannot read the version in: $VERSION_TEXT"
FIXTURES="${FIXTURES:-$REPO/apps/daemon/test/fixtures/claude-code-$VERSION}"

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/claude-code-probe.XXXXXX")" || stop "cannot create the scratch folder."
chmod 700 "$SCRATCH"
TMUX_SOCKET="claude-code-probe-$$"

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
  "$TSX" --conditions=source "$HELPER" "$@" --scratch "$SCRATCH"
}

CLAUDE_CONFIG="$SCRATCH/home/.orchestrator/claude-config"
RECORD="$SCRATCH/record"
echo "Claude Code probe"
echo "Claude Code:     $VERSION ($(command -v claude))"
echo "Model:           $MODEL"
echo "Scratch folder:  $SCRATCH (deleted at the end$( ((KEEP)) && echo ': no, --keep'))"
echo "Claude config:   $CLAUDE_CONFIG (the probe's own; your ~/.claude is not used)"
echo "Fixtures:        $FIXTURES"
echo

helper prepare || stop "the scratch layout could not be prepared."

if ((DRY_RUN)); then
  echo "Dry run: no login."
else
  cat << EOF
============================================================================
LOG IN (this uses no quota)
Claude Code now opens with the probe's own, empty configuration folder,
exactly as 'orchestrator-daemon login' does for the daemon's folder.
  1. Go through the first screens and log in with your Claude account
     (open the login link in your browser if asked). If Claude Code shows
     its prompt without asking you to log in, type /login and press Enter.
  2. When you see the normal prompt, type /exit and press Enter.
Do not send any message: it would use quota for nothing.
============================================================================
EOF
  read -r -p "Press Enter to open Claude Code..." _
  helper login
  [[ -f "$CLAUDE_CONFIG/.credentials.json" ]] ||
    stop "not logged in: $CLAUDE_CONFIG/.credentials.json is missing. Run the probe again and log in."
  echo "Logged in."
fi
echo

hook_seen() { # session, event
  grep -q "\"event\":\"$2\"" "$RECORD/hooks-$1.jsonl" 2> /dev/null
}

# Starts a session in the probe's own tmux server and waits for its SessionStart hook.
launch() { # name
  local name="$1" worktree="$SCRATCH/home/.orchestrator/worktrees/$1" args=() command waited=0 pane
  mapfile -d '' args < <(helper session --name "$name" --model "$MODEL") ||
    stop "the $name session's files could not be written."
  printf -v command '%q ' env -u TMUX -u TMUX_PANE "CLAUDE_CONFIG_DIR=$CLAUDE_CONFIG" \
    GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never claude "${args[@]}"
  tmux -L "$TMUX_SOCKET" new-session -d -s "$name" -x 200 -y 50 -c "$worktree" \
    "$command; echo CLAUDE-EXITED; sleep 600" || stop "tmux could not start the $name session."
  while ! hook_seen "$name" SessionStart; do
    pane="$(tmux -L "$TMUX_SOCKET" capture-pane -p -t "$name" 2> /dev/null)"
    if grep -q CLAUDE-EXITED <<< "$pane" || ((waited >= START_TIMEOUT)); then
      echo "$pane" > "$SCRATCH/pane-$name.txt"
      echo "The $name session did not start. Its screen:" >&2
      echo "$pane" >&2
      stop "Claude Code did not start (dialog, login or argument problem): paste the screen above to Claude."
    fi
    sleep 1
    waited=$((waited + 1))
  done
}

# Types /exit (no quota), waits briefly for SessionEnd, keeps the screen, closes the session.
finish() { # name
  local waited=0
  tmux -L "$TMUX_SOCKET" capture-pane -p -S -200 -t "$1" > "$SCRATCH/pane-$1.txt" 2> /dev/null
  tmux -L "$TMUX_SOCKET" send-keys -t "$1" -l '/exit' 2> /dev/null
  tmux -L "$TMUX_SOCKET" send-keys -t "$1" Enter 2> /dev/null
  while ! hook_seen "$1" SessionEnd && ((waited < 10)); do
    sleep 1
    waited=$((waited + 1))
  done
  tmux -L "$TMUX_SOCKET" kill-session -t "$1" 2> /dev/null
}

echo "Control session (a made-up setting, no prompt, no quota)..."
launch control
sleep "$SETTLE"
finish control

echo "Probe session (one prompt on $MODEL)..."
launch probe
waited=0
while ! hook_seen probe Stop && ! hook_seen probe StopFailure; do
  ((waited >= TURN_TIMEOUT)) && { echo "No end of turn after ${TURN_TIMEOUT}s: evaluating what was recorded."; break; }
  sleep 1
  waited=$((waited + 1))
done
waited=0
while ! grep -q rate_limits "$RECORD/status-line-probe.jsonl" 2> /dev/null && ((waited < STATUS_LINE_WAIT)); do
  sleep 1
  waited=$((waited + 1))
done
finish probe

echo
echo "===== paste from here to Claude ====="
helper evaluate --version "$VERSION" --model "$MODEL" --fixtures "$FIXTURES" | tee "$SCRATCH/results.txt"
RESULT=${PIPESTATUS[0]}
echo "===== to here ====="
echo
case "$RESULT" in
  0) echo "Every check passed." ;;
  1) echo "At least one check failed: paste the block above to Claude, who adjusts the specs with you." ;;
  2) ;;
  *) echo "The checks could not be evaluated, or the fixtures were not written: paste the block above to Claude." ;;
esac
if grep -q 'NOT ATTEMPTED' "$SCRATCH/results.txt"; then
  echo "The agent did not attempt every action: run the probe again (it asks for a new login)."
fi
exit "$RESULT"

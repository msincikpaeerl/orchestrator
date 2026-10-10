#!/usr/bin/env bash
# Allowlist smoke test (03, section 6; lot 2 plan, step I): checks, with the real Claude Code, that
# each default agent profile's allowlist lets the agent run what its role needs (install, test,
# lint, build, an edit, a commit) and refuses what it must not (curl, sudo, docker, the daemon's
# folder). Quality (lot 3 step H) is checked for reading and testing, and for refusing every
# command that writes a file or moves HEAD (an edit, a commit, checkout, reset, stash, merge, ...).
# For the owner only (working rule 10): sessions never run it; CI runs its dry run.
#
# One session per default profile, in a scratch Node.js project whose scripts only print a line.
# The settings and the argument list come from the daemon's own code
# (apps/daemon/scripts/allowlist-smoke.ts), with a recorder instead of the daemon's hook: this
# checks the allowlist and the settings' deny rules (the hook's rules are tested in CI).
#
# Everything lives in a scratch folder under the temporary folder, with a Claude configuration
# folder of its own: your ~/.claude and ~/.claude.json are never read or changed. Quota: one
# session per profile with one prompt, on the smallest model by default; a profile whose allowlist
# and deny rules are the same as a profile already checked is not run again (it says so).
# It refuses to run in CI or without a terminal, and asks you to type yes before any session.
#
# Usage: tools/smoke/allowlist-smoke.sh [--keep] [--model <alias>] [--profile <key>]
#                                       [--claude <executable>] [--dry-run]
#   --keep       keep the scratch folder (it holds Claude credentials: delete it yourself)
#   --model      model alias (default: haiku, the smallest)
#   --profile    check only this profile (default: every default profile with its own rules)
#   --claude     the claude executable to use (default: claude from PATH)
#   --dry-run    skip the login; only with the tests' fake claude given with --claude
#
# The report prints PASS, FAIL or NOT ATTEMPTED (a command the agent never tried) per profile and
# command, and for Quality one INFO line: what Claude Code answers for a tool its run does not
# list (never a verdict). It and the files it records are sanitised: paths, e-mail addresses and credentials are
# masked, and if your e-mail, Git user, organisation id or home folder still appears, nothing is
# shown and the recorded files are deleted.
#
# Exit code: 0 when every command passes, 1 when one fails, 2 when a command was not attempted,
# 3 when the smoke test could not run or the report was withheld.

set -uo pipefail

KEEP=0
DRY_RUN=0
CLAUDE_GIVEN=""
MODEL=haiku
ONLY=""
START_TIMEOUT="${SMOKE_START_TIMEOUT:-60}"
TURN_TIMEOUT="${SMOKE_TURN_TIMEOUT:-300}"

stop() {
  echo "STOPPED: $*" >&2
  exit 3
}

while (($# > 0)); do
  case "$1" in
    --keep) KEEP=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --model) MODEL="${2:?--model needs a value}"; shift ;;
    --profile) ONLY="${2:?--profile needs a value}"; shift ;;
    --claude)
      CLAUDE_GIVEN="$(cd "$(dirname "${2:?--claude needs a value}")" && pwd)/$(basename "$2")"
      PATH="$(dirname "$CLAUDE_GIVEN"):$PATH"
      shift
      ;;
    -h | --help) sed -n '2,32p' "$0"; exit 0 ;;
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
  guard_owner_terminal
fi
TSX="$REPO/apps/daemon/node_modules/.bin/tsx"
HELPER="$REPO/apps/daemon/scripts/allowlist-smoke.ts"

for tool in claude tmux git node; do
  command -v "$tool" > /dev/null 2>&1 || stop "$tool is not installed or not in PATH."
done
[[ -x "$TSX" ]] || stop "the repository's packages are missing: run pnpm install in $REPO first."

VERSION_TEXT="$(claude --version 2> /dev/null)" || stop "claude --version failed."
VERSION="$(grep -oE '[0-9]+\.[0-9]+\.[0-9]+' <<< "$VERSION_TEXT" | head -n 1)"
[[ -n "$VERSION" ]] || stop "cannot read the version in: $VERSION_TEXT"

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/allowlist-smoke.XXXXXX")" || stop "cannot create the scratch folder."
chmod 700 "$SCRATCH"
TMUX_SOCKET="allowlist-smoke-$$"

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
PROFILE_LINES="$(helper profiles)" || stop "the profiles in agents/ could not be read."
PROFILES=()
SKIPPED=()
while read -r key same; do
  [[ -n "$key" ]] || continue
  if [[ -n "$ONLY" ]]; then
    [[ "$key" == "$ONLY" ]] && PROFILES=("$key")
  elif [[ -n "$same" ]]; then
    # Same allowlist and deny rules as a profile already checked: not run again (quota).
    SKIPPED+=("$key (same allowlist and deny rules as $same)")
  else
    PROFILES+=("$key")
  fi
done <<< "$PROFILE_LINES"
if [[ -n "$ONLY" && ${#PROFILES[@]} -eq 0 ]]; then
  stop "no default profile $ONLY (profiles: $(cut -d' ' -f1 <<< "$PROFILE_LINES" | paste -sd' '))."
fi
echo "Allowlist smoke test"
echo "Claude Code:     $VERSION ($(command -v claude))"
echo "Model:           $MODEL"
echo "Profiles:        ${PROFILES[*]}"
for skipped in "${SKIPPED[@]}"; do
  echo "Not run again:   $skipped"
done
echo "Scratch folder:  $SCRATCH (deleted at the end$( ((KEEP)) && echo ': no, --keep'))"
echo "Claude config:   $CLAUDE_CONFIG (the smoke test's own; your ~/.claude is not used)"
echo

if ((DRY_RUN == 0)); then
  guard_confirm "${#PROFILES[@]} session(s) (${PROFILES[*]}), one prompt each on $MODEL (about 16 short tool calls each)."
fi
helper prepare || stop "the scratch layout could not be prepared."

if ((DRY_RUN)); then
  echo "Dry run: no login."
else
  cat << EOF
============================================================================
LOG IN (this uses no quota)
Claude Code now opens with the smoke test's own, empty configuration folder,
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
    stop "not logged in: $CLAUDE_CONFIG/.credentials.json is missing. Run the smoke test again and log in."
  echo "Logged in."
fi
echo

hook_seen() { # profile, event
  grep -q "\"event\":\"$2\"" "$RECORD/hooks-$1.jsonl" 2> /dev/null
}

for name in "${PROFILES[@]}"; do
  echo "Session of $name (one prompt on $MODEL)..."
  worktree="$SCRATCH/home/.orchestrator/worktrees/$name"
  mapfile -d '' args < <(helper session --name "$name" --model "$MODEL") ||
    stop "the $name session's files could not be written."
  printf -v command '%q ' env -u TMUX -u TMUX_PANE "CLAUDE_CONFIG_DIR=$CLAUDE_CONFIG" \
    GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never claude "${args[@]}"
  tmux -L "$TMUX_SOCKET" new-session -d -s "$name" -x 200 -y 50 -c "$worktree" \
    "$command; echo CLAUDE-EXITED; sleep 600" || stop "tmux could not start the $name session."
  waited=0
  while ! hook_seen "$name" SessionStart; do
    pane="$(tmux -L "$TMUX_SOCKET" capture-pane -p -t "$name" 2> /dev/null)"
    if grep -q CLAUDE-EXITED <<< "$pane" || ((waited >= START_TIMEOUT)); then
      echo "The $name session did not start. Its screen:" >&2
      echo "$pane" >&2
      stop "Claude Code did not start (dialog, login or argument problem): paste the screen above to Claude."
    fi
    sleep 1
    waited=$((waited + 1))
  done
  waited=0
  while ! hook_seen "$name" Stop && ! hook_seen "$name" StopFailure; do
    ((waited >= TURN_TIMEOUT)) && { echo "No end of turn after ${TURN_TIMEOUT}s: evaluating what was recorded."; break; }
    sleep 1
    waited=$((waited + 1))
  done
  tmux -L "$TMUX_SOCKET" send-keys -t "$name" -l '/exit' 2> /dev/null
  tmux -L "$TMUX_SOCKET" send-keys -t "$name" Enter 2> /dev/null
  waited=0
  while ! hook_seen "$name" SessionEnd && ((waited < 10)); do
    sleep 1
    waited=$((waited + 1))
  done
  tmux -L "$TMUX_SOCKET" kill-session -t "$name" 2> /dev/null
done

echo
echo "===== paste from here to Claude ====="
echo "Claude Code $VERSION, model $MODEL"
helper evaluate --profiles "$(IFS=,; echo "${PROFILES[*]}")" | tee "$SCRATCH/results.txt"
RESULT=${PIPESTATUS[0]}
echo "===== to here ====="
echo
case "$RESULT" in
  0) echo "Every command passed." ;;
  1) echo "At least one command failed: paste the block above to Claude, who adjusts the allowlists with you." ;;
  2) echo "The agent did not try every command: run the smoke test again (it asks for a new login)." ;;
  *) echo "The results could not be evaluated or were withheld: paste the block above to Claude." ;;
esac
exit "$RESULT"

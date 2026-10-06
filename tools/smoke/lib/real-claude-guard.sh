# Sourced (never run) by every script that can start the real Claude Code: the probe and the
# allowlist smoke test (tools/smoke/), and the spikes (tools/spike/). Only the owner runs those
# scripts with the real Claude Code (working rule 10): sessions, `pnpm verify` and CI run their
# syntax check and their dry runs against the fake `claude` of the tests, nothing else.
#
# Also sourced by the scripts that act on the real GitHub (github-smoke.sh, working rule 9), which
# set GUARD_ACTS_ON and GUARD_USES first, and use the GitHub functions at the end.
#
#   guard_dry_run <executable given with --claude>
#       A dry run goes on only when `claude` is that executable and it is the tests' fake.
#   guard_owner_terminal
#       A real run goes on only outside CI and in a terminal: called before anything else runs.
#   guard_confirm <what the script is about to use>
#       Says what the run uses and goes on only when the owner types "yes".
#   guard_real <what the script is about to use>
#       Both of the above.
#
#   guard_dry_run_github <GitHub address given with --github-url>
#       A dry run goes on only with a local address: the tests' fake GitHub, never github.com.
#   guard_not_own_repository <checkout> <owner/name>
#       Refuses the Orchestrator's own repository, read from the checkout's `origin`.
#
# Each refusal stops the script with exit code 3, before any session starts or anything is done
# on GitHub.

# What the script does, for the refusals, and what it uses, for the confirmation.
GUARD_ACTS_ON="${GUARD_ACTS_ON:-starts the real Claude Code}"
GUARD_USES="${GUARD_USES:-This uses the real Claude Code and your Claude quota}"

guard_refuse() {
  echo "REFUSED: $*" >&2
  echo "Nothing was started." >&2
  exit 3
}

guard_dry_run() {
  local given="${1:-}" found
  [[ -n "$given" ]] || guard_refuse "--dry-run needs --claude <the fake claude of the tests>."
  found="$(command -v claude 2> /dev/null)"
  [[ "$found" == "$given" ]] ||
    guard_refuse "--dry-run: claude is ${found:-missing}, not the executable given with --claude ($given)."
  # The shim written by installFakeClaude (apps/daemon/test/fake-claude/install.ts).
  grep -q 'FAKE_CLAUDE_DIR=' "$given" 2> /dev/null ||
    guard_refuse "--dry-run runs only with the fake claude of the tests; $given is not it."
}

guard_owner_terminal() {
  [[ -z "${CI:-}" ]] ||
    guard_refuse "CI is set. This script $GUARD_ACTS_ON: only the owner runs it, by hand."
  [[ -t 0 && -t 1 ]] ||
    guard_refuse "no terminal. This script $GUARD_ACTS_ON: only the owner runs it, by hand."
}

guard_confirm() {
  local answer=""
  echo "$GUARD_USES: $*"
  read -r -p 'Type yes to go on: ' answer || true
  [[ "$answer" == "yes" ]] || guard_refuse "not confirmed."
  echo
}

guard_real() {
  guard_owner_terminal
  guard_confirm "$@"
}

guard_dry_run_github() {
  local given="${1:-}"
  [[ -n "$given" ]] || guard_refuse "--dry-run needs --github-url <the fake GitHub of the tests>."
  [[ "$given" =~ ^http://(127\.[0-9]+\.[0-9]+\.[0-9]+|localhost|\[::1\]):[0-9]+/?$ ]] ||
    guard_refuse "--dry-run runs only against the fake GitHub of the tests, on this computer; $given is not one."
}

# `owner/name` of a GitHub URL (https, ssh or scp-like), in lower case; nothing for another host.
guard_github_name() {
  local url="${1%/}"
  url="${url%.git}"
  if [[ "$url" =~ ^(https://|ssh://git@|git@)github\.com[:/]([^/]+/[^/]+)$ ]]; then
    printf '%s\n' "${BASH_REMATCH[2],,}"
  fi
}

guard_not_own_repository() {
  local checkout="$1" given="${2,,}" origin own
  origin="$(git -C "$checkout" config --get remote.origin.url 2> /dev/null)" ||
    guard_refuse "cannot read this checkout's origin, so cannot make sure $2 is not the Orchestrator's own repository."
  own="$(guard_github_name "$origin")"
  [[ -n "$own" ]] ||
    guard_refuse "this checkout's origin ($origin) is not on github.com, so cannot make sure $2 is not the Orchestrator's own repository."
  [[ "$given" != "$own" ]] ||
    guard_refuse "$2 is the Orchestrator's own repository (this checkout's origin). Name a test repository."
}

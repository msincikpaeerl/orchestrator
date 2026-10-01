# Sourced (never run) by every script that can start the real Claude Code: the probe and the
# allowlist smoke test (tools/smoke/), and the spikes (tools/spike/). Only the owner runs those
# scripts with the real Claude Code (working rule 10): sessions, `pnpm verify` and CI run their
# syntax check and their dry runs against the fake `claude` of the tests, nothing else.
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
# Each refusal stops the script with exit code 3, before any session starts.

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
    guard_refuse "CI is set. This script starts the real Claude Code: only the owner runs it, by hand."
  [[ -t 0 && -t 1 ]] ||
    guard_refuse "no terminal. This script starts the real Claude Code: only the owner runs it, by hand."
}

guard_confirm() {
  local answer=""
  echo "This uses the real Claude Code and your Claude quota: $*"
  read -r -p 'Type yes to go on: ' answer || true
  [[ "$answer" == "yes" ]] || guard_refuse "not confirmed."
  echo
}

guard_real() {
  guard_owner_terminal
  guard_confirm "$@"
}

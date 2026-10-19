#!/usr/bin/env bash
# GitHub smoke test (lot 3 plan, step E): checks, on the real GitHub, what the Orchestrator's
# GitHub code and the daemon's push rely on, with no Claude quota. For the owner only (working
# rule 9): sessions never run it; CI runs its dry run against the tests' fake GitHub.
#
# Usage: tools/smoke/github-smoke.sh --repository <owner>/<name> [--restricted-token | --only-a27]
#          [--ci-wait-minutes <n>] [--owner-wait-minutes <n>]
#   --repository          a test repository of your account with the project skeleton (for
#                         example the one of a test project), never the Orchestrator's own
#   --restricted-token    also ask for the second, restricted token of step 10 (see below)
#   --only-a27            run step 12 alone (lot 4 step B): a few minutes, nothing to do on GitHub
#   --ci-wait-minutes     how long to wait for CI each time before giving up (default 15)
#   --owner-wait-minutes  how long to wait for each of your actions on GitHub (default 30)
#   --dry-run, --github-url <address>   for the tests only: against the fake GitHub
#
# The token: create one for this check only. The Orchestrator never shows its saved token again.
# On https://github.com/settings/personal-access-tokens/new create a fine-grained token:
#   Repository access: Only select repositories, the test repository only
#   Expiration: the shortest (7 days, or a custom date tomorrow)
#   Permissions (Repositories), one by one:
#     Metadata         Read-only (added by GitHub)
#     Contents         Read and write
#     Pull requests    Read and write
#     Actions          Read-only
#     Commit statuses  Read-only
# The Orchestrator's own token also has Administration and Workflows (Read and write): this
# script does not use them, so the token check of step 0 shows them Missing. Delete the token at
# the end: https://github.com/settings/personal-access-tokens
#
# The second token (--restricted-token, step 10, optional): on the same page, a second
# fine-grained token named orchestrator-smoke-restricted:
#   Repository access: Only select repositories, the test repository only
#   Expiration: the shortest
#   Permissions (Repositories), at first only:
#     Metadata         Read-only (added by GitHub)
#     Contents         Read-only
# The script checks that GitHub refuses it a push, a pull request, Actions runs and commit
# statuses. Then it pauses and asks you to change Contents to Read and write on that token's
# page (never Workflows, and never "Regenerate token": its value must stay the same); it then
# checks that a push adding a workflow file is refused. Delete it at the end too.
#
# The token is typed or pasted without being shown, kept only in memory, given to the script's
# Node.js helper through a pipe, and never written to disk, put in an argument or in the
# environment of another program, or printed: anything GitHub sends back is masked.
#
# Before anything is made, it reads the repository's merge settings: if squash or rebase merging
# is off, it stops and names the box to tick in the repository's settings.
#
# What it does in the repository: a branch orchestrator-smoke-<time> with a few commits to
# docs/orchestrator-smoke.md and its pull request, 3 CI runs (about 2 minutes each), reviews
# (four comment reviews stay: GitHub never deletes a posted review), then asks you to merge it
# (a 4th CI run starts on the default branch; the script does not wait for it). Then a second
# branch from the default branch as it was before, whose pull request conflicts (no CI run): the
# script asks you to close it, then posts one comment review on it. Step 11: two small pull
# requests, each adding its own page under docs/, which you merge, one with "Rebase and merge"
# and one with "Squash and merge" (the script waits for their CI first; 3 CI runs, and 2 more on
# the default branch), and a third one, based on the first of them, which it closes at once (it
# conflicts: no CI run). Step 12 (A27): a pull request with a title of 256 characters and a
# description of 65,536, the longest the Orchestrator sends, read back and closed at once (1 CI
# run, not waited for). At the end it deletes every branch it made. What stays: the merges on the
# default branch (docs/orchestrator-smoke.md, then 3 commits with the two step 11 pages), the
# closed pull requests with their comment reviews, and the workflow runs. If it stops early, it
# says what it left and how to remove it. You act on GitHub four times (five with the second
# token); each time the script says what to click, with the link.
#
# With --only-a27, only step 12 runs: one branch orchestrator-smoke-<time>-long-text, its pull
# request (closed at once, it stays closed) and 1 CI run; the branch is deleted at the end. No
# token check, nothing for you to do on GitHub; the token needs the same permissions.
#
# The result block at the end lists each step and assumption with PASS, FAIL or NOT ATTEMPTED;
# paste it back. Exit code: 0 when everything attempted passes, 1 when something fails, 3 when the
# script was refused or stopped before checking anything.

set -uo pipefail
# Never traced, even when started with bash -x: a traced line would print the token.
{ set +x; } 2> /dev/null
# No core dump of the script or its helper, which hold the token in memory.
ulimit -c 0

REPOSITORY=""
CI_WAIT_MINUTES=15
OWNER_WAIT_MINUTES=30
RESTRICTED=0
ONLY_A27=0
DRY_RUN=0
GITHUB_URL=""

stop() {
  echo "STOPPED: $*" >&2
  exit 3
}

while (($# > 0)); do
  case "$1" in
    --repository) REPOSITORY="${2:?--repository needs a value}"; shift ;;
    --ci-wait-minutes) CI_WAIT_MINUTES="${2:?--ci-wait-minutes needs a value}"; shift ;;
    --owner-wait-minutes) OWNER_WAIT_MINUTES="${2:?--owner-wait-minutes needs a value}"; shift ;;
    --restricted-token) RESTRICTED=1 ;;
    --only-a27) ONLY_A27=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --github-url) GITHUB_URL="${2:?--github-url needs a value}"; shift ;;
    -h | --help) sed -n '2,72p' "$0"; exit 0 ;;
    *) stop "unknown option $1 (see --help)" ;;
  esac
  shift
done

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
GUARD_ACTS_ON="acts on your real GitHub"
GUARD_USES="This acts on your real GitHub"
# shellcheck source=lib/real-claude-guard.sh
source "$REPO/tools/smoke/lib/real-claude-guard.sh"
if ((DRY_RUN)); then
  guard_dry_run_github "$GITHUB_URL"
  API_URL="${GITHUB_URL%/}"
  GIT_URL="${GITHUB_URL%/}"
else
  guard_owner_terminal
  [[ -z "$GITHUB_URL" ]] || guard_refuse "--github-url is for the dry run of the tests only."
  API_URL="https://api.github.com"
  GIT_URL="https://github.com"
fi
[[ "$REPOSITORY" =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$ ]] ||
  guard_refuse "--repository needs <owner>/<name> (see --help)."
[[ "$CI_WAIT_MINUTES" =~ ^[1-9][0-9]{0,2}$ ]] ||
  guard_refuse "--ci-wait-minutes needs a number of minutes, from 1 to 999."
[[ "$OWNER_WAIT_MINUTES" =~ ^[1-9][0-9]{0,2}$ ]] ||
  guard_refuse "--owner-wait-minutes needs a number of minutes, from 1 to 999."
guard_not_own_repository "$REPO" "$REPOSITORY"
((RESTRICTED && ONLY_A27)) &&
  guard_refuse "--only-a27 runs step 12 alone, which needs no second token: leave out --restricted-token."

TSX="$REPO/apps/server/node_modules/.bin/tsx"
HELPER="$REPO/apps/server/scripts/github-smoke.ts"
for tool in git node; do
  command -v "$tool" > /dev/null 2>&1 || stop "$tool is not installed or not in PATH."
done
[[ -x "$TSX" ]] || stop "the repository's packages are missing: run pnpm install in $REPO first."

echo "GitHub smoke test of $REPOSITORY"
echo
echo "You need a fine-grained token for this check only (the Orchestrator never shows its saved"
echo "token again), made on https://github.com/settings/personal-access-tokens/new with:"
echo "  Repository access: Only select repositories, $REPOSITORY only"
echo "  Expiration: the shortest"
echo "  Permissions: Metadata Read-only, Contents Read and write, Pull requests Read and write,"
echo "               Actions Read-only, Commit statuses Read-only"
echo "  (not Administration or Workflows: the Orchestrator's token has them, this script does not"
echo "  use them, and step 0 shows them Missing)"
if ((RESTRICTED)); then
  echo
  echo "And a second fine-grained token, named orchestrator-smoke-restricted, for step 10:"
  echo "  Repository access: Only select repositories, $REPOSITORY only"
  echo "  Expiration: the shortest"
  echo "  Permissions: Metadata Read-only and Contents Read-only, nothing else for now"
  echo "  (the script pauses later and tells you how to change Contents to Read and write)"
fi
echo "Delete them when the script has finished: https://github.com/settings/personal-access-tokens"
echo
if ((ONLY_A27)); then
  guard_confirm "in $REPOSITORY, a branch orchestrator-smoke-<time>-long-text (deleted at the end), one pull request with the longest title and description (closed at once; it stays closed), and 1 CI run (about 2 Actions minutes on a private repository)."
else
  guard_confirm "in $REPOSITORY, branches orchestrator-smoke-<time>, six pull requests (you merge three, one by squash and one by rebase; three stay closed), and 10 CI runs (Actions minutes, about 20 on a private repository); the merges stay on the default branch."
fi

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/github-smoke.XXXXXX")" || stop "cannot create the scratch folder."
chmod 700 "$SCRATCH"
# The terminal's settings, echo on, put back at the end whatever happens: on Ctrl+C while the
# token is typed, tsx (which starts the helper beside the token's prompt) puts back the settings
# it found when it started, with the echo off.
TERMINAL=""
[[ -t 0 ]] && TERMINAL="$(stty -g)"
trap '[[ -z "$TERMINAL" ]] || stty "$TERMINAL" 2> /dev/null; rm -rf "$SCRATCH"' EXIT
trap 'exit 3' INT TERM

# Reads the token from the terminal without showing it and writes it, with the shell's built-in
# printf, to standard output: the pipe to the helper. Run as the left side of that pipe, so the
# token lives only in this short-lived subshell, never in the script's own shell: no here-string
# or here-document (bash may write those to a temporary file), no external command, no export.
# If Ctrl+C comes while a token is typed, the terminal's echo is restored first. With
# --restricted-token, the second token follows the same way, as the pipe's second line.
read_token() {
  local token="" saved=""
  { set +x; } 2> /dev/null
  if [[ -t 0 ]]; then
    saved="$(stty -g)"
    trap 'stty "$saved"; echo >&2; exit 130' INT TERM
  fi
  IFS= read -rs -p 'Paste the token (it is not shown), then press Enter: ' token
  [[ -t 0 ]] && echo >&2
  printf '%s\n' "$token"
  token=""
  if ((RESTRICTED)); then
    IFS= read -rs -p 'Paste the second, restricted token (it is not shown), then press Enter: ' token
    [[ -t 0 ]] && echo >&2
    printf '%s\n' "$token"
    token=""
  fi
  unset token
}

HELPER_ARGS=(--repository "$REPOSITORY" --api-url "$API_URL" --git-url "$GIT_URL"
  --scratch "$SCRATCH" --ci-wait-minutes "$CI_WAIT_MINUTES"
  --owner-wait-minutes "$OWNER_WAIT_MINUTES")
((DRY_RUN)) && HELPER_ARGS+=(--dry-run)
((RESTRICTED)) && HELPER_ARGS+=(--restricted-token)
((ONLY_A27)) && HELPER_ARGS+=(--only-a27)
read_token | "$TSX" --conditions=source "$HELPER" "${HELPER_ARGS[@]}"
exit "${PIPESTATUS[1]}"

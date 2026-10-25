#!/usr/bin/env bash
# Browser tests check (05, section 2; lot 5 step C1): runs Help > Machines > "Browser tests" as
# the owner would, in a fresh Ubuntu container: Node.js through nvm, the one-time command for
# Chromium's system libraries (with sudo, as Help gives it), then `orchestrator-daemon browsers`
# from the daemon package built from this repository. It passes when the command ends with
# Chromium starting headless, and that Chromium is still there after npm's cache is cleaned and
# another Playwright version removes the browsers no install uses (`playwright uninstall`, the
# clean-up a project's own install also runs).
#
# Run again when the Playwright version pinned in packages/protocol changes, or Help's command.
# It needs Docker and the internet (apt, nvm, Node.js, npm and Playwright's download: a few
# hundred MB per image); it is not run in CI. Nothing is installed on this computer: everything
# happens in throw-away containers (`docker run --rm`), from the images pinned below.
#
# Usage: tools/smoke/browser-deps-check.sh [--image <name>]
#   --image   check only this image: ubuntu24.04 or ubuntu26.04 (default: both)
#
# Exit code: 0 when every image passes, 1 when one fails, 3 when the check could not run.

set -uo pipefail

# Ubuntu 24.04 and 26.04 (the owner's WSL, 26.04.1 LTS), pinned to a dated build.
declare -A IMAGES=(
  [ubuntu24.04]=ubuntu:noble-20260930.1
  [ubuntu26.04]=ubuntu:resolute-20261006
)
NVM_VERSION=v0.40.8
# Another Playwright version, as a project may pin: its clean-up must keep the daemon's Chromium.
OTHER_PLAYWRIGHT=1.63.0
ONLY=""

stop() {
  echo "STOPPED: $*" >&2
  exit 3
}

while (($# > 0)); do
  case "$1" in
    --image) ONLY="${2:?--image needs a value}"; shift ;;
    --help | -h) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) stop "unknown option $1 (see --help)" ;;
  esac
  shift
done
if [[ -n "$ONLY" && -z "${IMAGES[$ONLY]+set}" ]]; then
  stop "unknown image $ONLY: ubuntu24.04 or ubuntu26.04"
fi

command -v docker >/dev/null || stop "Docker is needed"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NODE_VERSION="$(cat "$ROOT/.nvmrc")"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/browser-deps-XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT
# The container's user is not this one: it reads the scripts and the package only.
chmod 755 "$SCRATCH"

echo "Building the daemon package..."
(cd "$ROOT/apps/daemon" && pnpm exec tsx --conditions=source scripts/pack.ts --out "$SCRATCH") \
  >"$SCRATCH/pack.txt" 2>&1 || { cat "$SCRATCH/pack.txt" >&2; stop "the daemon package could not be built"; }
PACKAGE="$(cd "$SCRATCH" && ls orchestrator-daemon-*.tgz)"
chmod 644 "$SCRATCH/$PACKAGE"
# Help's command, read from Help itself: the check runs what the owner reads.
LIBRARIES="$(grep -o 'sudo env "PATH=$PATH" npx --yes playwright@[0-9.]* install-deps chromium' \
  "$ROOT/docs/user/machines.md" | head -n 1)"
[[ -n "$LIBRARIES" ]] || stop "Help > Machines gives no libraries command"
echo "Help's command: $LIBRARIES"
REVISION="$(grep -o "PLAYWRIGHT_CHROMIUM_REVISION = '[0-9]*'" "$ROOT/packages/protocol/src/daemon/browsers.ts" | grep -o '[0-9]*')"
[[ -n "$REVISION" ]] || stop "no pinned Chromium revision in packages/protocol"

# Runs as the image's root: a user like the owner, with sudo, then the owner's steps as that user.
cat >"$SCRATCH/as-root.sh" <<'EOF'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq sudo curl ca-certificates >/dev/null
useradd --create-home --shell /bin/bash owner
echo 'owner ALL=(ALL) NOPASSWD:ALL' >/etc/sudoers.d/owner
su - owner -c 'bash /check/as-owner.sh'
EOF
cat >"$SCRATCH/as-owner.sh" <<EOF
set -euo pipefail
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh | bash >/dev/null
export NVM_DIR="\$HOME/.nvm"
. "\$NVM_DIR/nvm.sh"
nvm install $NODE_VERSION >/dev/null
echo "Node.js \$(node --version) through nvm"
npm install -g --silent /check/$PACKAGE
echo '--- Help: the system libraries'
$LIBRARIES
echo '--- Help: orchestrator-daemon browsers'
orchestrator-daemon browsers
echo "--- npm's cache cleaned, then Playwright $OTHER_PLAYWRIGHT's clean-up of unused browsers"
npm cache clean --force 2>/dev/null
rm -rf "\$HOME/.npm/_npx"
PLAYWRIGHT_BROWSERS_PATH="\$HOME/.orchestrator/browsers" npx --yes playwright@$OTHER_PLAYWRIGHT uninstall
if [[ -f "\$HOME/.orchestrator/browsers/chromium_headless_shell-$REVISION/INSTALLATION_COMPLETE" ]]; then
  echo "Chromium $REVISION kept"
else
  echo "Chromium $REVISION removed"
  exit 1
fi
EOF

failed=0
for name in "${!IMAGES[@]}"; do
  [[ -n "$ONLY" && "$name" != "$ONLY" ]] && continue
  image="${IMAGES[$name]}"
  echo "=== $name ($image)"
  if docker run --rm -v "$SCRATCH:/check:ro" "$image" bash /check/as-root.sh >"$SCRATCH/$name.txt" 2>&1; then
    tail -n 3 "$SCRATCH/$name.txt"
    echo "PASS $name"
  else
    tail -n 25 "$SCRATCH/$name.txt"
    echo "FAIL $name"
    failed=1
  fi
done
exit "$failed"

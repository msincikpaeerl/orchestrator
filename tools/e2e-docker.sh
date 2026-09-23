#!/bin/sh
# Runs the end-to-end tests in the pinned Playwright image, exactly as CI does (ADR 0021):
# `pnpm test:e2e`, with arguments for Playwright after it (`pnpm test:e2e --project phone`).
# Needs the development PostgreSQL (docs/dev/testing.md). The image tag must match the
# @playwright/test version of apps/web (checked by apps/web/e2e/image-version.test.ts).
set -eu

image=mcr.microsoft.com/playwright:v1.63.0-noble
repo=$(cd "$(dirname "$0")/.." && pwd)

# The UI is built on the host, with the same lock file as the container sees.
pnpm --filter @orchestrator/web build

# Same path inside the container, so the pnpm symlinks of node_modules resolve; host network,
# so the tests reach the development PostgreSQL on localhost; files written as the current user.
exec docker run --rm --init --ipc=host --network host \
  --user "$(id -u):$(id -g)" --env HOME=/tmp \
  --env CI --env E2E_PORT --env TEST_DATABASE_URL \
  --volume "$repo:$repo" --workdir "$repo/apps/web" \
  "$image" ./node_modules/.bin/playwright test "$@"

import { readFileSync } from 'node:fs';
import { z } from 'zod';

const PackageJson = z.object({ version: z.string().min(1) });

/**
 * The daemon's version, shared with the server (09, section 6). Read from the package.json next
 * to the code: `apps/daemon/package.json` in the workspace, the installed package's otherwise.
 */
export const DAEMON_VERSION = PackageJson.parse(
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')),
).version;

/** Replaced in the bundle by `scripts/bundle.ts`; not defined when run from the sources. */
declare const __ORCHESTRATOR_DAEMON_BUILD__: string | undefined;

/**
 * The package's build identifier (05, section 2), written into the bundle when the package is
 * built; null for a daemon run from its sources (development, tests).
 */
export const DAEMON_BUILD: string | null =
  typeof __ORCHESTRATOR_DAEMON_BUILD__ === 'string' ? __ORCHESTRATOR_DAEMON_BUILD__ : null;

/** The version and build, as `--version` and `status` show them. */
export function versionText(version = DAEMON_VERSION, build = DAEMON_BUILD): string {
  return build === null
    ? `${version} (run from its sources, no build)`
    : `${version} (build ${build})`;
}

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

import { readFileSync } from 'node:fs';
import { z } from 'zod';

const PackageJson = z.object({ version: z.string().min(1) });

/** Version shared by the server, UI and daemon (09, section 6), read from this package's package.json. */
export const SERVER_VERSION = PackageJson.parse(
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')),
).version;

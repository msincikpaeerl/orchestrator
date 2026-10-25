import { z } from 'zod';
import { boundedText } from '../text-limits.js';

/**
 * A capability tag of a machine: `git`, `node`, `docker`, `android-sdk` (01, section 3.8). Its own
 * module: projects' required capabilities use it too, and `connection.ts` imports the runs' module.
 */
export const Capability = boundedText().regex(
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
  'must be lowercase letters and digits, separated by "-"',
);
export type Capability = z.infer<typeof Capability>;

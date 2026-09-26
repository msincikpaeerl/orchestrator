import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { safeJson } from './config.js';

/** Why the daemon last stopped (05, section 3.2), shown by `doctor` and `status`. */
export const StopReason = z.enum([
  /** Stopped by `systemctl --user stop`, Ctrl+C or a signal. */
  'stopped',
  'unknown_token',
  'revoked',
  'incompatible',
  'replaced',
]);
export type StopReason = z.infer<typeof StopReason>;

export const LastStop = z.object({
  at: z.iso.datetime(),
  reason: StopReason,
  /** The cause and the fix, as printed when the daemon stopped. */
  message: z.string(),
});
export type LastStop = z.infer<typeof LastStop>;

export async function readLastStop(path: string): Promise<LastStop | null> {
  try {
    const parsed = LastStop.safeParse(safeJson(await readFile(path, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function writeLastStop(path: string, stop: LastStop): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(stop, null, 2)}\n`, { mode: 0o600 });
}

/** An accepted `welcome` or a new enrollment makes the last stop history. */
export async function clearLastStop(path: string): Promise<void> {
  await rm(path, { force: true });
}

export function describeLastStop(stop: LastStop): string {
  return `Last stop (${new Date(stop.at).toLocaleString()}): ${stop.message}`;
}

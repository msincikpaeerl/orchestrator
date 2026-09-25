import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { MachineToken } from '@orchestrator/protocol';
import { z } from 'zod';
import { UserError } from './errors.js';

/** `~/.orchestrator/config.json`, mode 600 (05, sections 3.1 and 7). */
export const DaemonConfig = z.object({
  serverUrl: z.string(),
  machineId: z.uuid(),
  machineName: z.string(),
  machineToken: MachineToken,
  /** PEM certificate authority given with `enroll --ca-file` (05, section 3.2), or null. */
  ca: z.string().nullable(),
});
export type DaemonConfig = z.infer<typeof DaemonConfig>;

/** The configuration, null when the machine is not enrolled; invalid content throws. */
export async function readConfig(path: string): Promise<DaemonConfig | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const parsed = DaemonConfig.safeParse(safeJson(text));
  if (!parsed.success) {
    throw new UserError(
      `${path} is damaged. Enroll the machine again with a new enrollment code (the machine's page in the Orchestrator).`,
    );
  }
  return parsed.data;
}

/** The configuration, or a refusal saying how to enroll. */
export async function requireConfig(path: string): Promise<DaemonConfig> {
  const config = await readConfig(path);
  if (!config) {
    throw new UserError(
      'This machine is not enrolled yet: type the "orchestrator-daemon enroll ..." command shown by the Orchestrator when you added the machine.',
    );
  }
  return config;
}

/**
 * Writes the configuration readable by the owner only: a temporary file of mode 600 renamed over
 * the old one, in a folder of mode 700, so the token is never readable by others, even briefly.
 */
export async function writeConfig(path: string, config: DaemonConfig): Promise<void> {
  const folder = dirname(path);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await chmod(folder, 0o700);
  const temporary = `${path}.${String(process.pid)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

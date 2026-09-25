import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** The first executable file named `name` in the folders of `pathValue`, or null. */
export function findExecutable(name: string, pathValue: string | undefined): string | null {
  for (const folder of (pathValue ?? '').split(':')) {
    if (!folder || !isAbsolute(folder)) continue;
    const candidate = join(folder, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not in this folder.
    }
  }
  return null;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs a command without a shell and returns its output, whatever its exit code; null when it
 * cannot start or runs longer than `timeoutMs`.
 */
export function runCommand(
  file: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<CommandResult | null> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { env: options.env ?? process.env, timeout: options.timeoutMs ?? 10_000, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') {
          resolve(null);
          return;
        }
        resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
      },
    );
  });
}

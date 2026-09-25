import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { detectWsl } from './detect.js';
import type { DoctorEnvironment } from './doctor.js';
import type { DaemonPaths } from './paths.js';
import { parseUnit } from './unit.js';

/** Folders of managed Claude Code settings (05, section 8; Claude Code's documentation). */
export function managedSettingsDirs(wsl: boolean): string[] {
  return ['/etc/claude-code', ...(wsl ? ['/mnt/c/Program Files/ClaudeCode'] : [])];
}

/** The unit's PATH, when the service is installed. */
function unitPath(paths: DaemonPaths): string | null {
  try {
    return parseUnit(readFileSync(paths.unit, 'utf8')).path;
  } catch {
    return null;
  }
}

/**
 * Where this process's checks look (05, section 8). The running daemon checks its own PATH. The
 * `doctor` command typed in a terminal checks the service's PATH when the service is installed,
 * since that is what the daemon runs with, and the terminal's otherwise.
 */
export function doctorEnvironment(
  paths: DaemonPaths,
  mode: 'daemon' | 'command',
  env: NodeJS.ProcessEnv = process.env,
): DoctorEnvironment {
  const wsl = detectWsl(env);
  const servicePath = mode === 'command' ? unitPath(paths) : null;
  return {
    paths,
    toolPath: servicePath ?? env.PATH ?? '',
    toolPathLabel:
      servicePath !== null
        ? "the service's PATH"
        : mode === 'daemon'
          ? "the daemon's PATH"
          : "this terminal's PATH",
    systemPath: env.PATH ?? '',
    nodePath: process.execPath,
    wsl,
    managedSettingsDirs: managedSettingsDirs(wsl),
    username: userInfo().username,
  };
}

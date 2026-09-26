import { readFileSync } from 'node:fs';
import type { Capability, MachineOs } from '@orchestrator/protocol';
import { findExecutable } from './exec.js';

/** WSL, from the kernel release (`...-microsoft-standard-WSL2`) or WSL's own variable. */
export function detectWsl(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft|wsl/i.test(readFileSync('/proc/sys/kernel/osrelease', 'utf8'));
  } catch {
    return false;
  }
}

export function machineOs(wsl: boolean): MachineOs {
  return wsl ? 'wsl' : 'linux';
}

/** Capabilities the daemon detects (01, section 3.8): the tools found in its PATH. */
const DETECTED: readonly Capability[] = ['docker', 'git', 'node'];

export function detectCapabilities(pathValue: string | undefined): Capability[] {
  return DETECTED.filter((name) => findExecutable(name, pathValue) !== null);
}

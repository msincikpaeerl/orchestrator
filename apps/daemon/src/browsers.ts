import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BROWSER_TESTS_CAPABILITY,
  PLAYWRIGHT_CHROMIUM_REVISION,
  PLAYWRIGHT_VERSION,
} from '@orchestrator/protocol';
import { findExecutable, runCommand } from './exec.js';

// Browser tests on the machine (05, section 2; owner's answer 5, lot 5 step A): the Chromium of
// the pinned Playwright version in the daemon's `browsers/` folder, checked by `doctor` and
// downloaded by `orchestrator-daemon browsers`.

/** The owner's one-time command for Chromium's system libraries, as Help > Machines gives it. */
export const LIBRARIES_COMMAND = `sudo env "PATH=$PATH" npx --yes playwright@${PLAYWRIGHT_VERSION} install-deps chromium`;

/** Where Playwright puts the headless shell of each processor (its own registry). */
const HEADLESS_SHELL: Partial<Record<NodeJS.Architecture, string>> = {
  x64: 'chrome-headless-shell-linux64',
  arm64: 'chrome-headless-shell-linux-arm64',
};

/** The pinned revision's headless shell in `browsers`; null on a processor Playwright lacks. */
export function headlessShellPath(
  browsers: string,
  arch: NodeJS.Architecture = process.arch,
): string | null {
  const folder = HEADLESS_SHELL[arch];
  if (!folder) return null;
  return join(
    browsers,
    `chromium_headless_shell-${PLAYWRIGHT_CHROMIUM_REVISION}`,
    folder,
    'chrome-headless-shell',
  );
}

export type BrowserState =
  | { kind: 'ok' }
  | { kind: 'not_installed' }
  | { kind: 'unsupported'; arch: string }
  | { kind: 'libraries'; missing: string[] }
  | { kind: 'no_start'; output: string };

/** Libraries `ldd` reports "not found", each once, in its order. */
export function missingLibraries(lddOutput: string): string[] {
  const names = [...lddOutput.matchAll(/^\s*(\S+)\s+=>\s+not found/gm)].map((match) => match[1]);
  return [...new Set(names.filter((name): name is string => name !== undefined))];
}

/**
 * Whether the pinned Chromium starts headless (05, section 8): installed (Playwright writes
 * `INSTALLATION_COMPLETE` once a download is unpacked), its libraries found by `ldd`, and a blank
 * page printed. Playwright launches Chromium without its sandbox, which Ubuntu 24.04 and later
 * restrict for unprivileged users; the check does the same.
 */
export async function checkBrowsers(
  browsers: string,
  toolPath: string,
  arch: NodeJS.Architecture = process.arch,
): Promise<BrowserState> {
  const shell = headlessShellPath(browsers, arch);
  if (!shell) return { kind: 'unsupported', arch };
  const installed = join(
    browsers,
    `chromium_headless_shell-${PLAYWRIGHT_CHROMIUM_REVISION}`,
    'INSTALLATION_COMPLETE',
  );
  if (!existsSync(installed) || !existsSync(shell)) return { kind: 'not_installed' };

  const env = { ...process.env, PATH: toolPath };
  const ldd = findExecutable('ldd', toolPath);
  if (ldd) {
    const result = await runCommand(ldd, [shell], { env });
    const missing = missingLibraries(result?.stdout ?? '');
    if (missing.length > 0) return { kind: 'libraries', missing };
  }
  const result = await runCommand(shell, ['--no-sandbox', '--dump-dom', 'about:blank'], { env });
  if (result?.code === 0 && result.stdout.includes('<html')) return { kind: 'ok' };
  const output = result ? `${result.stderr}\n${result.stdout}` : '';
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    kind: 'no_start',
    output: result ? lines.slice(-3).join(' ') || `exit code ${String(result.code)}` : 'no answer',
  };
}

/** What the owner reads about a state, in `doctor` and at the end of `orchestrator-daemon browsers`. */
export function describeBrowsers(state: BrowserState): string {
  switch (state.kind) {
    case 'ok':
      return `Chromium ${PLAYWRIGHT_CHROMIUM_REVISION} (Playwright ${PLAYWRIGHT_VERSION}) starts headless: agents can run browser tests (capability ${BROWSER_TESTS_CAPABILITY}).`;
    case 'not_installed':
      return 'Not set up: type "orchestrator-daemon browsers" so agents can run browser tests on this machine.';
    case 'unsupported':
      return `Not available: Playwright has no Chromium for this processor (${state.arch}).`;
    case 'libraries':
      return `System libraries missing: ${state.missing.join(', ')}. Install them once with: ${LIBRARIES_COMMAND}`;
    case 'no_start':
      return `Chromium does not start headless (${state.output}). Install its system libraries once with: ${LIBRARIES_COMMAND}`;
  }
}

/** Runs `npx` with the terminal's output; resolves with its exit code, or null if it cannot start. */
function runInTerminal(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { env, stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', () => {
      resolve(null);
    });
    child.on('exit', (code, signal) => {
      resolve(code ?? (signal ? 128 : 1));
    });
  });
}

/**
 * `orchestrator-daemon browsers` (05, section 8): downloads the pinned Playwright version's
 * Chromium into the daemon's folder with the PATH the daemon runs with, then checks it. Typed
 * by the owner; the daemon never runs it on its own.
 */
export async function installBrowsers(
  options: { browsers: string; toolPath: string; toolPathLabel: string },
  out: (line: string) => void,
): Promise<number> {
  const npx = findExecutable('npx', options.toolPath);
  if (!npx) {
    out(
      `npx not found in ${options.toolPathLabel}. Install Node.js 24 with nvm (Help > Machines > "Before you start"), then type "orchestrator-daemon install-service" again from a terminal where "npx --version" works.`,
    );
    return 1;
  }
  await mkdir(options.browsers, { recursive: true, mode: 0o700 });
  out(`Downloading the Chromium of Playwright ${PLAYWRIGHT_VERSION} into ${options.browsers}...`);
  const code = await runInTerminal(
    npx,
    ['--yes', `playwright@${PLAYWRIGHT_VERSION}`, 'install', 'chromium'],
    { ...process.env, PATH: options.toolPath, PLAYWRIGHT_BROWSERS_PATH: options.browsers },
  );
  if (code !== 0) {
    out(
      `The download failed (npx ${code === null ? 'did not start' : `ended with exit code ${String(code)}`}): check this computer's internet connection, then type "orchestrator-daemon browsers" again.`,
    );
    return 1;
  }
  const state = await checkBrowsers(options.browsers, options.toolPath);
  out(
    state.kind === 'not_installed'
      ? `The download ended, but the folder holds no Chromium ${PLAYWRIGHT_CHROMIUM_REVISION}: type "orchestrator-daemon browsers" again.`
      : describeBrowsers(state),
  );
  if (state.kind !== 'ok') return 1;
  out(
    'Restart the daemon (systemctl --user restart orchestrator-daemon) so the Orchestrator sees it on the machine page.',
  );
  return 0;
}

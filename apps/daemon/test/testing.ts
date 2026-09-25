import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { daemonPaths, type DaemonPaths } from '../src/paths.js';

// Test helpers for the daemon (`@orchestrator/daemon/testing`): a throw-away home folder, fake
// executables in a folder of their own, and the `orchestrator-daemon` command run from its
// TypeScript sources. Tests never touch the real home folder, systemd or Claude Code.

const root = fileURLToPath(new URL('..', import.meta.url));
const tsxCli = createRequire(join(root, 'package.json')).resolve('tsx/cli');
const cliSource = join(root, 'src', 'cli.ts');

export interface TestHome {
  root: string;
  /** Holds the fake executables; first in PATH. */
  bin: string;
  paths: DaemonPaths;
  /** HOME, ORCHESTRATOR_HOME and XDG_CONFIG_HOME inside `root`; PATH is `bin` then Node.js. */
  env: NodeJS.ProcessEnv;
  remove(): Promise<void>;
}

export async function createTestHome(): Promise<TestHome> {
  const folder = await mkdtemp(join(tmpdir(), 'orchestrator-daemon-test-'));
  const bin = join(folder, 'bin');
  await mkdir(bin);
  const env: NodeJS.ProcessEnv = {
    HOME: join(folder, 'home'),
    ORCHESTRATOR_HOME: join(folder, 'home', '.orchestrator'),
    XDG_CONFIG_HOME: join(folder, 'home', '.config'),
    // Node.js's own folder, for `node` and `npm`; no system folder, so only fakes are found.
    PATH: [bin, dirname(process.execPath)].join(delimiter),
    LANG: 'C.UTF-8',
    LOG_LEVEL: 'info',
  };
  await mkdir(env.HOME ?? '', { recursive: true });
  return {
    root: folder,
    bin,
    paths: daemonPaths(env),
    env,
    remove: () => rm(folder, { recursive: true, force: true }),
  };
}

/** Writes an executable shell script named `name` in `folder`. */
export async function fakeExecutable(
  folder: string,
  name: string,
  script: string,
): Promise<string> {
  const path = join(folder, name);
  await writeFile(path, `#!/bin/sh\n${script}\n`);
  await chmod(path, 0o755);
  return path;
}

/** Shell code printing `text` with the shell's own `printf`: the test PATH has no `cat`. */
function print(text: string): string {
  return `printf '%s\\n' '${text.replace(/'/g, "'\\''")}'`;
}

/** A fake tool that prints `output` whatever its arguments. */
export function printing(folder: string, name: string, output: string): Promise<string> {
  return fakeExecutable(folder, name, print(output));
}

/** A fake tool that appends its arguments, one call per line, to `log`, and prints `output`. */
export function recording(folder: string, name: string, log: string, output = ''): Promise<string> {
  return fakeExecutable(folder, name, `echo "$*" >> '${log}'\n${output ? print(output) : ''}`);
}

/** Healthy fakes of every tool the daemon checks, for tests about something else. */
export async function healthyTools(home: TestHome): Promise<void> {
  await printing(home.bin, 'git', 'git version 2.53.0');
  await printing(home.bin, 'tmux', 'tmux 3.6');
  await printing(home.bin, 'claude', '2.1.282 (Claude Code)');
  await mkdir(home.paths.claudeConfig, { recursive: true });
  await writeFile(join(home.paths.claudeConfig, '.credentials.json'), '{}');
}

export interface DaemonProcess {
  child: ChildProcess;
  stdout(): string;
  stderr(): string;
  /** Resolves with the exit code. */
  exited: Promise<number>;
}

/** Starts `orchestrator-daemon <args>` from the sources, with the test home's environment. */
export function spawnDaemon(args: string[], env: NodeJS.ProcessEnv, input?: string): DaemonProcess {
  const child = spawn(process.execPath, [tsxCli, '--conditions=source', cliSource, ...args], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  if (input !== undefined) child.stdin.end(input);
  const exited = new Promise<number>((resolve) => {
    child.on('exit', (code, signal) => {
      resolve(code ?? (signal ? 128 : 1));
    });
  });
  return { child, stdout: () => stdout, stderr: () => stderr, exited };
}

/** Runs `orchestrator-daemon <args>` to its end. */
export async function runDaemon(
  args: string[],
  env: NodeJS.ProcessEnv,
  input?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const process = spawnDaemon(args, env, input);
  const code = await process.exited;
  return { code, stdout: process.stdout(), stderr: process.stderr() };
}

/** Polls `condition` every 50 ms until it holds, or throws after `timeoutMs`. */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
  what = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline)
      throw new Error(`${what} not reached within ${String(timeoutMs)} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

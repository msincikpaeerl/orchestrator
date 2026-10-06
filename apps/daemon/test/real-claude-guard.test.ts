import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakeClaude, type FakeClaude } from './fake-claude/install.js';
import { fakeExecutable } from './testing.js';

// The guard of every script that can start the real Claude Code (working rule 10; owner's
// decision, lot 2 step M): only the owner runs them, by hand. Without --dry-run they refuse in CI
// and without a terminal, and ask for "yes"; a dry run goes on only with the tests' fake claude.
// The fake is first in PATH here, so even a broken guard would never reach the real one.

const repository = resolve(import.meta.dirname, '..', '..', '..');
const guard = join(repository, 'tools', 'smoke', 'lib', 'real-claude-guard.sh');

/** Each script and mode that starts Claude Code, with the options that select it. */
const REAL: [string, string[]][] = [
  ['tools/smoke/claude-code-probe.sh', []],
  ['tools/smoke/allowlist-smoke.sh', []],
  ['tools/spike/claude-code-spike.sh', []],
  ['tools/spike/claude-code-spike.sh', ['--long']],
  ['tools/spike/claude-code-spike.sh', ['--probe-limit']],
  ['tools/spike/claude-code-spike-v2.sh', []],
  ['tools/spike/claude-code-spike-v3.sh', []],
];
/** The scripts with a dry run. */
const DRY: [string, string[]][] = [
  ['tools/smoke/claude-code-probe.sh', []],
  ['tools/smoke/allowlist-smoke.sh', []],
  ['tools/spike/claude-code-spike.sh', ['--probe-limit']],
];

let root: string;
let home: string;
let fake: FakeClaude;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'od-guard-'));
  await mkdir(join(root, 'bin'));
  home = join(root, 'home');
  await mkdir(home);
  fake = await installFakeClaude(join(root, 'bin'), join(root, 'fake'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function run(
  command: string[],
  env: NodeJS.ProcessEnv = {},
  input?: string,
): Promise<{ code: number; output: string }> {
  return new Promise((done) => {
    const [file = 'bash', ...args] = command;
    const child = spawn(file, args, {
      cwd: repository,
      env: {
        ...process.env,
        CI: undefined,
        HOME: home,
        TMPDIR: root,
        PATH: `${join(root, 'bin')}:${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
        ...env,
      },
      // No terminal: stdin is closed, or the given input.
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // A script that exits first closes the pipe: the rest of the input is not needed.
    child.stdin.on('error', () => undefined);
    child.stdin.end(input ?? '');
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    child.on('exit', (code) => {
      done({ code: code ?? 1, output });
    });
  });
}

// A script that refuses exits before reading its input; writing to it then fails with EPIPE,
// which must not end the test run as an uncaught error (seen in lot 3 step E1).
it('runs a script that exits without reading its input', async () => {
  expect((await run(['bash', '-c', 'exit 0'], {}, 'yes\n'.repeat(1 << 18))).code).toBe(0);
});

/** Nothing started and nothing left: no session of the fake, no folder in TMPDIR or HOME. */
async function nothingStarted(): Promise<void> {
  expect(await fake.log()).toEqual([]);
  expect((await readdir(root)).sort()).toEqual(['bin', 'fake', 'home']);
  expect(await readdir(home)).toEqual([]);
}

describe('scripts starting the real Claude Code: the guard', () => {
  it.each(REAL)('%s %j refuses in CI', async (script, args) => {
    const { code, output } = await run(['bash', script, ...args], { CI: 'true' });
    expect(output).toMatch(/REFUSED: CI is set\./);
    expect(output).toMatch(/Nothing was started\./);
    expect(code).toBe(3);
    await nothingStarted();
  });

  it.each(REAL)('%s %j refuses without a terminal', async (script, args) => {
    const { code, output } = await run(['bash', script, ...args]);
    expect(output).toMatch(/REFUSED: no terminal\./);
    expect(code).toBe(3);
    await nothingStarted();
  });

  it.each(DRY)('%s %j runs a dry run only with the fake claude', async (script, args) => {
    // Another executable named claude, which records if it is ever run.
    const other = join(root, 'other');
    await mkdir(other);
    await fakeExecutable(other, 'claude', `touch '${join(root, 'other-ran')}'\necho 2.1.283`);
    const notFake = await run([
      'bash',
      script,
      ...args,
      '--dry-run',
      '--claude',
      join(other, 'claude'),
    ]);
    expect(notFake.output).toMatch(
      /REFUSED: --dry-run runs only with the fake claude of the tests/,
    );
    expect(notFake.code).toBe(3);
    const missing = await run(['bash', script, ...args, '--dry-run']);
    expect(missing.output).toMatch(/REFUSED: --dry-run needs --claude/);
    expect(missing.code).toBe(3);
    await rm(other, { recursive: true });
    await nothingStarted();
  });

  it('asks for yes and refuses any other answer', async () => {
    const confirm = (answer: string) =>
      run(
        ['bash', '-c', `source '${guard}'; guard_confirm "one session"; echo GONE ON`],
        {},
        answer,
      );
    const no = await confirm('no\n');
    expect(no.output).toMatch(/This uses the real Claude Code and your Claude quota: one session/);
    expect(no.output).toMatch(/REFUSED: not confirmed\./);
    expect(no.output).not.toMatch(/GONE ON/);
    expect(no.code).toBe(3);
    expect((await confirm('')).code).toBe(3);
    const yes = await confirm('yes\n');
    expect(yes.output).toMatch(/GONE ON/);
    expect(yes.code).toBe(0);
  });
});

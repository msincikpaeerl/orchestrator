import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { mkdir, open, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createTestHome, stopHomeProcesses, type TestHome } from '@orchestrator/daemon/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  skeletonWorkflow,
  startFakeGitHub,
  type FakeAccount,
  type FakeGitHub,
  type FakeRepository,
} from './fake-github.js';

// The owner's GitHub smoke script (lot 3 plan, steps E2 and E3) against the fake GitHub: its
// guard (working rule 9), the dry run of steps 0 to 5 with the fake playing GitHub Actions, and
// the proof that the token stays where the script says (addition 2 of the plan's step E): no
// process shows it in its arguments or environment while the script runs, the script's own shell
// never holds it in its memory, bash writes no here-document file, no file holds it afterwards,
// the output does not contain it, and Ctrl+C while it is typed gives the terminal's echo back.

const checkout = resolve(import.meta.dirname, '..', '..', '..');
const script = join(checkout, 'tools', 'smoke', 'github-smoke.sh');
const guard = join(checkout, 'tools', 'smoke', 'lib', 'real-claude-guard.sh');
const TIMEOUT = 120_000;

/**
 * Longer than a pipe's buffer (64 KiB): bash writes a here-string or here-document of that size
 * to a temporary file, so a mistake there becomes visible (bash 5.1 and later keep shorter ones
 * in a pipe).
 */
const TOKEN = `github_pat_${randomBytes(53_000).toString('base64url')}`;
/** What the leak checks look for: a part of the token no other text holds. */
const PROBE = TOKEN.slice(20, 84);

/** The dedicated token's permissions, as the script's first screen asks for them. */
const dedicated: FakeAccount['permissions'] = {
  metadata: 'read',
  contents: 'write',
  pull_requests: 'write',
  actions: 'read',
  statuses: 'read',
};

let home: TestHome;
let github: FakeGitHub;
let repo: FakeRepository;

beforeEach(async () => {
  home = await createTestHome();
  github = await startFakeGitHub();
  repo = {
    name: 'smoke-test',
    private: true,
    workflows: [skeletonWorkflow()],
    files: { 'README.md': '# Smoke test\n', 'docs/user/index.md': '# Help\n' },
  };
  github.accounts.set(TOKEN, {
    login: 'octo-owner',
    id: 5_550_123,
    permissions: { ...dedicated },
    repositories: [repo],
  });
});

afterEach(async () => {
  await github.close();
  await stopHomeProcesses(home);
  await home.remove();
});

function environment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...home.env,
    // The system's tools (bash, git, mktemp, stty) after Node.js.
    PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
    TMPDIR: home.root,
    CI: undefined,
    ...extra,
  };
}

interface Finished {
  code: number;
  output: string;
}

/** Runs the script without a terminal, `input` on its standard input. */
function start(
  args: string[],
  input: string,
  extra: NodeJS.ProcessEnv = {},
  shellOptions: string[] = [],
): { child: ChildProcessWithoutNullStreams; finished: Promise<Finished> } {
  const child = spawn('bash', [...shellOptions, script, ...args], {
    cwd: checkout,
    env: environment(extra),
    stdio: ['pipe', 'pipe', 'pipe'],
    // Its own process group, as in a terminal: Ctrl+C reaches the whole group.
    detached: true,
  });
  child.stdin.on('error', () => undefined);
  child.stdin.end(input);
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
  const finished = new Promise<Finished>((done) => {
    child.on('close', (code) => {
      done({ code: code ?? 1, output });
    });
  });
  return { child, finished };
}

function run(args: string[], input = '', extra: NodeJS.ProcessEnv = {}): Promise<Finished> {
  return start(args, input, extra).finished;
}

const dryRun = (repository = 'octo-owner/smoke-test') => [
  '--dry-run',
  '--github-url',
  github.url,
  '--repository',
  repository,
];

/** Resolves when the script has printed `text`. */
function waitForOutput(child: ChildProcessWithoutNullStreams, text: string): Promise<void> {
  return new Promise((done) => {
    let output = '';
    const listener = (chunk: string) => {
      output += chunk;
      if (output.includes(text)) {
        child.stdout.off('data', listener);
        done();
      }
    };
    child.stdout.on('data', listener);
  });
}

/** Nothing reached the fake GitHub and nothing was left in the temporary folder. */
async function nothingDone(): Promise<void> {
  expect(github.requests).toEqual([]);
  expect(github.gitRequests).toEqual([]);
  expect(await leftInTemporaryFolder()).toEqual([]);
}

/** What the script left in the temporary folder, besides the test home and `tsx`'s own folder. */
async function leftInTemporaryFolder(): Promise<string[]> {
  return (await readdir(home.root)).filter(
    (name) => !['bin', 'home'].includes(name) && !name.startsWith('tsx-'),
  );
}

describe('the guard of the GitHub smoke script', () => {
  it('refuses in CI', async () => {
    const { code, output } = await run(['--repository', 'octo-owner/smoke-test'], 'yes\n', {
      CI: 'true',
    });
    expect(output).toMatch(/REFUSED: CI is set\. This script acts on your real GitHub/);
    expect(code).toBe(3);
    await nothingDone();
  });

  it('refuses without a terminal', async () => {
    const { code, output } = await run(['--repository', 'octo-owner/smoke-test'], 'yes\n');
    expect(output).toMatch(/REFUSED: no terminal\. This script acts on your real GitHub/);
    expect(code).toBe(3);
    await nothingDone();
  });

  it('runs a dry run only against a local address', async () => {
    const missing = await run(['--dry-run', '--repository', 'octo-owner/smoke-test']);
    expect(missing.output).toMatch(/REFUSED: --dry-run needs --github-url/);
    expect(missing.code).toBe(3);
    for (const address of [
      'https://api.github.com',
      'http://github.com:80',
      'http://10.0.0.1:80',
    ]) {
      const real = await run(['--dry-run', '--github-url', address, '--repository', 'a/b']);
      expect(real.output).toMatch(/REFUSED: --dry-run runs only against the fake GitHub/);
      expect(real.code).toBe(3);
    }
    await nothingDone();
  });

  it("refuses the Orchestrator's own repository, read from the checkout's origin", async () => {
    const origins: [string, string][] = [
      ['git@github.com:Some-Owner/Orchestrator.git', 'some-owner/orchestrator'],
      ['https://github.com/some-owner/orchestrator', 'Some-Owner/Orchestrator'],
      ['https://github.com/some-owner/orchestrator.git/', 'some-owner/orchestrator'],
      ['ssh://git@github.com/some-owner/orchestrator.git', 'some-owner/orchestrator'],
    ];
    const checkouts = join(home.root, 'checkouts');
    for (const [index, [origin, given]] of origins.entries()) {
      const folder = join(checkouts, String(index));
      await mkdir(folder, { recursive: true });
      const own = await guardCall(folder, origin, given);
      expect(own.output).toMatch(/REFUSED: .* is the Orchestrator's own repository/);
      expect(own.code).toBe(3);
      expect((await guardCall(folder, origin, 'some-owner/test-project')).code).toBe(0);
    }
    const none = join(checkouts, 'none');
    await mkdir(none);
    const unknown = await guardCall(none, null, 'some-owner/test-project');
    expect(unknown.output).toMatch(/REFUSED: cannot read this checkout's origin/);
    const elsewhere = await guardCall(none, 'https://example.com/a/b.git', 'a/b');
    expect(elsewhere.output).toMatch(/REFUSED: this checkout's origin .* is not on github\.com/);
    await rm(checkouts, { recursive: true });

    // The script itself, with this checkout's origin.
    const origin = await gitOutput(['-C', checkout, 'config', '--get', 'remote.origin.url']);
    const name = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(origin.trim())?.[1];
    expect(
      name,
      `this checkout's origin (${origin.trim()}) names a GitHub repository`,
    ).toBeDefined();
    const refused = await run(dryRun((name ?? '').toUpperCase()), 'yes\n');
    expect(refused.output).toMatch(/REFUSED: .* is the Orchestrator's own repository/);
    expect(refused.code).toBe(3);
    await nothingDone();
  });

  it('asks for yes before anything, and refuses any other answer', async () => {
    for (const answer of ['no\n', '', 'YES\n']) {
      const { code, output } = await run(dryRun(), answer);
      expect(output).toMatch(/This acts on your real GitHub: in octo-owner\/smoke-test, a branch/);
      expect(output).toMatch(/REFUSED: not confirmed\./);
      expect(code).toBe(3);
    }
    await nothingDone();
  });

  it('refuses a repository that does not exist, having created nothing', async () => {
    const { code, output } = await run(dryRun('octo-owner/no-such-repository'), `yes\n${TOKEN}\n`);
    expect(output).toMatch(
      /REFUSED: octo-owner\/no-such-repository does not exist, or the token cannot see it/,
    );
    expect(output).toMatch(/Nothing was done on GitHub\./);
    expect(code).toBe(3);
    expect(github.requests.every((request) => request.method === 'GET')).toBe(true);
    expect(github.gitRequests).toEqual([]);
    expect(output).not.toContain(PROBE);
  });

  it('stops when no token is given, or when GitHub refuses it', async () => {
    const empty = await run(dryRun(), 'yes\n\n');
    expect(empty.output).toMatch(/STOPPED: no token was given\. Nothing was done on GitHub\./);
    expect(empty.code).toBe(3);
    const wrong = await run(dryRun(), 'yes\ngithub_pat_NotAValidToken0123456789abcdef\n');
    expect(wrong.output).toMatch(/STOPPED: GitHub refused the token/);
    expect(wrong.output).not.toMatch(/NotAValidToken/);
    expect(wrong.code).toBe(3);
  });
});

/** The absolute path of `name` in the tests' PATH. */
function executable(name: string): string {
  const found = (process.env.PATH ?? '')
    .split(':')
    .map((folder) => join(folder, name))
    .find((path) => existsSync(path));
  if (!found) throw new Error(`${name} is needed`);
  return found;
}

function gitOutput(args: string[]): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn('git', args, { env: environment() });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    child.on('error', fail);
    child.on('close', () => {
      done(output);
    });
  });
}

/** `guard_not_own_repository` on a checkout whose origin is `origin` (none when null). */
async function guardCall(folder: string, origin: string | null, given: string): Promise<Finished> {
  await gitOutput(['init', '--quiet', folder]);
  await gitOutput(['-C', folder, 'remote', 'remove', 'origin']);
  if (origin !== null) await gitOutput(['-C', folder, 'remote', 'add', 'origin', origin]);
  return new Promise((done) => {
    const child = spawn(
      'bash',
      ['-c', `source '${guard}'; guard_not_own_repository "$1" "$2"`, 'guard', folder, given],
      { env: environment() },
    );
    let output = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    child.on('close', (code) => {
      done({ code: code ?? 1, output });
    });
  });
}

// ---------------------------------------------------------------------------------------------
// The leak proof

/**
 * Watches every process while the script runs: those showing the token in their arguments or
 * environment, and whether the script's own shell (`shell`) ever holds it in its memory.
 */
function watchProcesses(shell: number): {
  stop: () => Promise<{ leaks: string[]; memoryRead: boolean }>;
} {
  const leaks = new Set<string>();
  let memoryRead = false;
  const probe = Buffer.from(PROBE);
  const sampling = { running: true };
  const loop = (async () => {
    while (sampling.running) {
      for (const pid of await readdir('/proc').catch(() => [] as string[])) {
        if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
        const [command, environ] = await Promise.all([
          readFile(`/proc/${pid}/cmdline`).catch(() => null),
          readFile(`/proc/${pid}/environ`).catch(() => null),
        ]);
        if (command?.includes(probe)) {
          leaks.add(`arguments of ${command.toString().slice(0, 80).replace(/\0/g, ' ')}`);
        }
        if (environ?.includes(probe)) leaks.add(`environment of process ${pid}`);
      }
      const memory = await memoryHolds(shell, probe);
      if (memory !== null) memoryRead = true;
      if (memory === true) leaks.add("memory of the script's own shell");
      await new Promise((done) => setTimeout(done, 10));
    }
  })();
  return {
    stop: async () => {
      sampling.running = false;
      await loop;
      return { leaks: [...leaks], memoryRead };
    },
  };
}

/**
 * Whether the process's writable memory holds `probe`; null when it could not be read (gone).
 * The test is the script's parent, which Linux lets read its children's memory.
 */
async function memoryHolds(pid: number, probe: Buffer): Promise<boolean | null> {
  const maps = await readFile(`/proc/${String(pid)}/maps`, 'utf8').catch(() => null);
  const handle = await open(`/proc/${String(pid)}/mem`, 'r').catch(() => null);
  if (maps === null || handle === null) {
    await handle?.close();
    return null;
  }
  let read = false;
  try {
    for (const line of maps.split('\n')) {
      const range = /^([0-9a-f]+)-([0-9a-f]+) rw/.exec(line);
      if (!range) continue;
      const from = BigInt(`0x${range[1] ?? '0'}`);
      const size = Number(BigInt(`0x${range[2] ?? '0'}`) - from);
      if (size > 256 << 20) continue;
      const buffer = Buffer.alloc(size);
      try {
        await handle.read(buffer, 0, size, from);
      } catch {
        continue;
      }
      read = true;
      if (buffer.includes(probe)) return true;
    }
  } finally {
    await handle.close();
  }
  return read ? false : null;
}

/** Files bash creates for a here-string or here-document in the temporary folder. */
function watchHereDocuments(): { watcher: FSWatcher; seen: string[] } {
  const seen: string[] = [];
  const watcher = watch(home.root, (_event, name) => {
    if (name?.startsWith('sh-thd')) seen.push(name);
  });
  return { watcher, seen };
}

async function filesHolding(folder: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (path: string): Promise<void> => {
    const entries = await readdir(path, { withFileTypes: true }).catch(() => null);
    if (entries === null) {
      if ((await readFile(path).catch(() => null))?.includes(PROBE)) found.push(path);
      return;
    }
    for (const entry of entries) await visit(join(path, entry.name));
  };
  await visit(folder);
  return found;
}

/**
 * Plays GitHub Actions for the pull request's runs: the first completes once the script has
 * tried to read the log of one of its unfinished jobs (A14); the second fails on the broken link,
 * as the skeleton's CI does; the others pass.
 */
function playActions(): () => void {
  const timer = setInterval(() => {
    const runs = github.runs(repo).filter((each) => each.event === 'pull_request');
    for (const [index, each] of runs.entries()) {
      if (each.status === 'completed') continue;
      const logAsked = each.jobs.some((job) =>
        github.requests.some((request) =>
          request.path.includes(`/actions/jobs/${String(job.id)}/logs`),
        ),
      );
      if (index === 0 && !logAsked) continue;
      github.completeRun(
        each,
        index === 1
          ? [
              {
                job: 'docs-links',
                step: 'Check documentation links',
                log: 'docs/orchestrator-smoke.md\n  5:3-5:70  warning  Link to unknown file: `orchestrator-smoke-missing.md`  missing-file  remark-validate-links\n\n⚠ 1 warning',
              },
              { job: 'ci', step: 'Check that every job passed', log: '' },
            ]
          : [],
      );
    }
  }, 20);
  return () => {
    clearInterval(timer);
  };
}

describe('the dry run of the GitHub smoke script', () => {
  it(
    'passes steps 1 to 5 with the daemon push, the token staying in memory only',
    async () => {
      const hereDocuments = watchHereDocuments();
      const stopActions = playActions();
      const { child, finished } = start(dryRun(), `yes\n${TOKEN}\n`);
      const watcher = watchProcesses(child.pid ?? 0);
      const { code, output } = await finished;
      const { leaks, memoryRead } = await watcher.stop();
      stopActions();
      hereDocuments.watcher.close();

      // The leak proof.
      expect(leaks).toEqual([]);
      expect(memoryRead, "the script's shell memory was read at least once").toBe(true);
      expect(hereDocuments.seen).toEqual([]);
      expect(output).not.toContain(PROBE);
      expect(output).not.toContain(TOKEN.slice(0, 24));
      expect(await filesHolding(home.root)).toEqual([]);
      expect(await filesHolding(github.root)).toEqual([]);
      // The scratch folder is gone.
      expect(await leftInTemporaryFolder()).toEqual([]);

      // Every step and assumption of steps 1 to 5.
      expect(output, output).toMatch(
        /Step 0 \(the token check\): Administration: Missing.*Contents: OK/,
      );
      for (const step of [1, 2, 3, 4, 5]) {
        expect(output).toContain(`Step ${String(step)}: PASS`);
      }
      for (const step of [6, 7, 8, 9, 10]) {
        expect(output).toContain(`Step ${String(step)}: NOT ATTEMPTED`);
      }
      const passed = ['A1', 'A4', 'A5', 'A6', 'A12', 'A13', 'A14', 'A15', 'A17', 'A22'];
      for (const assumption of [...passed, 'A24', 'A25', 'A26']) {
        expect(output).toMatch(new RegExp(`^${assumption}: PASS$`, 'm'));
      }
      for (const assumption of ['A2', 'A3', 'A7', 'A8', 'A9', 'A10', 'A11', 'A16', 'A18']) {
        expect(output).toMatch(new RegExp(`^${assumption}: NOT ATTEMPTED$`, 'm'));
      }
      // The daemon's reading of each diverged push, with Git's words.
      expect(output).toMatch(/the daemon's reading: diverged[\s\S]*fetch first/);
      expect(output).toMatch(/the daemon's reading: diverged[\s\S]*non-fast-forward/);
      expect(output).toMatch(/^Script: [0-9a-f]{40}( with local changes)?$/m);
      expect(output).toMatch(/^Git: \d+\.\d+/m);
      expect(output).toMatch(/Nothing of this run is left on GitHub\./);
      expect(code).toBe(0);

      // What GitHub holds afterwards: the pull request closed, the branch gone.
      expect(github.pullRequest(repo, 1)).toMatchObject({ state: 'closed', merged: false });
      expect([...github.branches(repo).keys()]).toEqual(['main']);
      expect(github.runs(repo).map((each) => each.event)).toEqual([
        'pull_request',
        'pull_request',
        'pull_request',
      ]);
      // The log was downloaded without the API's Authorization (A13).
      expect(github.logRequests.length).toBeGreaterThan(0);
      expect(github.logRequests.every((request) => request.authorization === undefined)).toBe(true);
    },
    TIMEOUT,
  );

  it(
    'stops when CI does not finish in time, saying what it left on GitHub',
    async () => {
      // No workflow: no run ever starts. A minute of waiting lasts a second in the dry run.
      repo.workflows = [];
      const { code, output } = await run(
        [...dryRun(), '--ci-wait-minutes', '2'],
        `yes\n${TOKEN}\n`,
      );
      expect(output).toMatch(/FAIL {2}CI did not finish within 2 minutes \(no run started/);
      expect(output).toMatch(/STOPPED at step 3\./);
      expect(output).toMatch(/^Step 3: FAIL/m);
      expect(output).toMatch(/^Step 4: NOT ATTEMPTED/m);
      expect(output).toMatch(/Left on GitHub by this run, to remove by hand:/);
      expect(output).toContain(`- pull request #1: ${github.url}/octo-owner/smoke-test/pull/1`);
      expect(output).toMatch(
        /- branch orchestrator-smoke-\S+: .*\/octo-owner\/smoke-test\/branches/,
      );
      expect(output).not.toContain(PROBE);
      expect(code).toBe(1);
      expect(github.pullRequest(repo, 1).state).toBe('open');
      expect(
        [...github.branches(repo).keys()].some((name) => name.startsWith('orchestrator-smoke-')),
      ).toBe(true);
      expect(await leftInTemporaryFolder()).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'says once what it left on GitHub when stopped with Ctrl+C',
    async () => {
      // Actions never completes: the script waits for CI at step 3.
      const { child, finished } = start(dryRun(), `yes\n${TOKEN}\n`);
      await waitForOutput(child, 'Waiting for CI');
      process.kill(-(child.pid ?? 0), 'SIGINT');
      const { code, output } = await finished;
      expect(output.match(/Stopped \(Ctrl\+C\)\./g)).toHaveLength(1);
      expect(output.match(/===== Result: paste this block back =====/g)).toHaveLength(1);
      expect(output).toMatch(/^Step 2: PASS/m);
      expect(output).toMatch(/Left on GitHub by this run, to remove by hand:/);
      expect(output).toContain(`- pull request #1: ${github.url}/octo-owner/smoke-test/pull/1`);
      expect(output).not.toContain(PROBE);
      expect(code).toBe(3);
      expect(await leftInTemporaryFolder()).toEqual([]);
    },
    TIMEOUT,
  );

  it('prints no token when started with bash -x', async () => {
    const { code, output } = await start(
      dryRun('octo-owner/no-such-repository'),
      `yes\n${TOKEN}\n`,
      {},
      ['-x'],
    ).finished;
    expect(output).toMatch(/REFUSED: octo-owner\/no-such-repository does not exist/);
    expect(output).not.toContain(PROBE);
    expect(code).toBe(3);
  });

  it(
    "gives the terminal's echo back when Ctrl+C comes while the token is typed",
    async () => {
      // `script` gives the command a terminal; `stty -a` then reads that terminal's settings.
      const command = [
        'bash',
        `'${script}'`,
        ...dryRun().map((arg) => `'${arg}'`),
        '; echo "EXIT=$?"; stty -a',
      ].join(' ');
      // `script` runs the command with $SHELL: bash, which goes on after a child that ends itself
      // on Ctrl+C (sh would stop at once and never print the terminal's settings).
      const child = spawn('script', ['-qfc', command, '/dev/null'], {
        cwd: checkout,
        env: environment({ SHELL: executable('bash') }),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let output = '';
      let step = 0;
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        output += chunk;
        if (step === 0 && output.includes('Type yes to go on: ')) {
          step = 1;
          child.stdin.write('yes\r');
        }
        if (step === 1 && output.includes('Paste the token')) {
          step = 2;
          child.stdin.write(PROBE.slice(0, 10));
          setTimeout(() => child.stdin.write('\x03'), 300);
        }
      });
      await new Promise((done) => child.on('close', done));
      expect(output).toMatch(/EXIT=3/);
      // `-echo` would mean the echo was left off.
      expect(output).toMatch(/[ \n]echo[ \r\n]/);
      expect(output).not.toMatch(/-echo[ \r\n]/);
      expect(output).not.toContain(PROBE.slice(0, 10));
      await nothingDone();
    },
    TIMEOUT,
  );
});

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
  type FakeReply,
  type FakeRepository,
  type RecordedRequest,
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
/** The second, restricted token of step 10, as long, with its own probe. */
const RESTRICTED_TOKEN = `github_pat_${randomBytes(53_000).toString('base64url')}`;
const RESTRICTED_PROBE = RESTRICTED_TOKEN.slice(20, 84);

/** The dedicated token's permissions, as the script's first screen asks for them. */
/** The second token's permissions at first: Metadata and Contents read only. */
const restrictedAccount = (): FakeAccount => ({
  login: 'octo-owner',
  id: 5_550_123,
  permissions: { metadata: 'read', contents: 'read' },
  repositories: [repo],
});

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
    files: {
      'README.md': '# Smoke test\n',
      'docs/user/index.md': '# Help\n',
      // The skeleton's CI file: a `pull_request` run needs it in the merge commit (A29).
      '.github/workflows/ci.yml': 'name: CI\n',
    },
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

/** The owner's three actions on GitHub's site, as the script asks for them. */
interface OwnerPlay {
  /** Step 8, "merge pull request #1": the default merges with a merge commit. */
  merge?: 'merge' | 'squash' | 'close' | 'nothing';
  /** Step 9, "close pull request #2": `delete-branch` also deletes its branch. */
  close?: 'close' | 'delete-branch' | 'nothing';
  /** Step 10, "give the second token Contents write". */
  token?: 'contents' | 'workflows' | 'regenerate' | 'nothing';
  /** Step 11, "merge pull request #n with "Rebase and merge"": the default does so. */
  rebase?: 'rebase' | 'squash' | 'nothing';
  /** Step 11, "merge pull request #n with "Squash and merge"": the default does so. */
  squash?: 'squash' | 'nothing';
}

/** Plays the owner on GitHub's site when the script asks (its "Your turn on GitHub" lines). */
function playOwner(child: ChildProcessWithoutNullStreams, play: OwnerPlay = {}): void {
  let output = '';
  const done = new Set<string>();
  const once = (marker: string, action: () => void) => {
    if (done.has(marker) || !output.includes(marker)) return;
    done.add(marker);
    // As a person would: a moment after the script has asked.
    setTimeout(action, 100);
  };
  /** Step 11's merges: the pull request's number read from the script's words. */
  const merging = (button: string, play: string) => {
    const found = new RegExp(
      `Your turn on GitHub: merge pull request #(\\d+) with "${button}"\\.`,
    ).exec(output);
    if (!found) return;
    const number = Number(found[1]);
    once(found[0], () => {
      if (play === 'squash' || play === 'rebase') github.mergePullRequest(repo, number, play);
    });
  };
  child.stdout.on('data', (chunk: string) => {
    output += chunk;
    merging('Rebase and merge', play.rebase ?? 'rebase');
    merging('Squash and merge', play.squash ?? 'squash');
    once('Your turn on GitHub: merge pull request #1.', () => {
      const merge = play.merge ?? 'merge';
      if (merge === 'merge' || merge === 'squash') github.mergePullRequest(repo, 1, merge);
      if (merge === 'close') github.closePullRequest(repo, 1);
    });
    once('Your turn on GitHub: close pull request #2 without merging it.', () => {
      const close = play.close ?? 'close';
      if (close === 'nothing') return;
      github.closePullRequest(repo, 2);
      if (close === 'delete-branch') void deleteOnGitHub(github.pullRequest(repo, 2).head);
    });
    once('Your turn on GitHub: give the second token Contents write', () => {
      const token = play.token ?? 'contents';
      const account = github.accounts.get(RESTRICTED_TOKEN);
      if (!account || token === 'nothing') return;
      if (token === 'regenerate') {
        github.accounts.delete(RESTRICTED_TOKEN);
        return;
      }
      account.permissions.contents = 'write';
      if (token === 'workflows') account.permissions.workflows = 'write';
    });
  });
}

/** "Delete branch" on GitHub's site, with the owner's token. */
async function deleteOnGitHub(branch: string): Promise<void> {
  const response = await fetch(
    `${github.url}/repos/octo-owner/smoke-test/git/refs/heads/${branch}`,
    { method: 'DELETE', headers: { authorization: `Bearer ${TOKEN}` } },
  );
  expect(response.status).toBe(204);
}

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
      expect(output).toMatch(
        /This acts on your real GitHub: in octo-owner\/smoke-test, branches orchestrator-smoke-<time>, five pull requests \(you merge three, one by squash and one by rebase; two stay closed\)/,
      );
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
function watchProcesses(
  shell: number,
  probes: string[] = [PROBE],
): {
  stop: () => Promise<{ leaks: string[]; memoryRead: boolean }>;
} {
  const leaks = new Set<string>();
  let memoryRead = false;
  const buffers = probes.map((probe) => Buffer.from(probe));
  const sampling = { running: true };
  const loop = (async () => {
    while (sampling.running) {
      for (const pid of await readdir('/proc').catch(() => [] as string[])) {
        if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
        const [command, environ] = await Promise.all([
          readFile(`/proc/${pid}/cmdline`).catch(() => null),
          readFile(`/proc/${pid}/environ`).catch(() => null),
        ]);
        for (const probe of buffers) {
          if (command?.includes(probe)) {
            leaks.add(`arguments of ${command.toString().slice(0, 80).replace(/\0/g, ' ')}`);
          }
          if (environ?.includes(probe)) leaks.add(`environment of process ${pid}`);
        }
      }
      for (const probe of buffers) {
        const memory = await memoryHolds(shell, probe);
        if (memory !== null) memoryRead = true;
        if (memory === true) leaks.add("memory of the script's own shell");
      }
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

async function filesHolding(folder: string, probe = PROBE): Promise<string[]> {
  const found: string[] = [];
  const visit = async (path: string): Promise<void> => {
    const entries = await readdir(path, { withFileTypes: true }).catch(() => null);
    if (entries === null) {
      if ((await readFile(path).catch(() => null))?.includes(probe)) found.push(path);
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

/**
 * The fake GitHub's answer to the first pull request opened, without its `head`: GitHub created
 * it (201), but the GitHub layer cannot read the answer.
 */
function unreadableFirstPullRequest(): (request: RecordedRequest, reply: FakeReply) => FakeReply {
  let done = false;
  return (request, reply) => {
    if (done || request.method !== 'POST' || !request.path.endsWith('/pulls')) return reply;
    if (reply.status !== 201) return reply;
    done = true;
    const body = { ...(reply.body as Record<string, unknown>) };
    delete body.head;
    return { ...reply, body };
  };
}

describe('the dry run of the GitHub smoke script', () => {
  it(
    'passes every step with both tokens, the owner acting on GitHub, the tokens staying in memory only',
    async () => {
      github.accounts.set(RESTRICTED_TOKEN, restrictedAccount());
      const hereDocuments = watchHereDocuments();
      const stopActions = playActions();
      const { child, finished } = start(
        [...dryRun(), '--restricted-token'],
        `yes\n${TOKEN}\n${RESTRICTED_TOKEN}\n`,
      );
      playOwner(child);
      const watcher = watchProcesses(child.pid ?? 0, [PROBE, RESTRICTED_PROBE]);
      const { code, output } = await finished;
      const { leaks, memoryRead } = await watcher.stop();
      stopActions();
      hereDocuments.watcher.close();

      // The leak proof, for both tokens, the pause of step 10 included.
      expect(leaks).toEqual([]);
      expect(memoryRead, "the script's shell memory was read at least once").toBe(true);
      expect(hereDocuments.seen).toEqual([]);
      for (const probe of [PROBE, RESTRICTED_PROBE]) {
        expect(output).not.toContain(probe);
        expect(await filesHolding(home.root, probe)).toEqual([]);
        expect(await filesHolding(github.root, probe)).toEqual([]);
      }
      expect(output).not.toContain(TOKEN.slice(0, 24));
      expect(output).not.toContain(RESTRICTED_TOKEN.slice(0, 24));
      // The scratch folder is gone.
      expect(await leftInTemporaryFolder()).toEqual([]);

      // Every step and assumption.
      expect(output, output).toMatch(
        /Step 0 \(the token check\): Administration: Missing.*Contents: OK/,
      );
      expect(output).toContain(
        'Second token: of octo-owner too, and it sees octo-owner/smoke-test.',
      );
      for (let step = 1; step <= 11; step++) {
        expect(output).toContain(`Step ${String(step)}: PASS`);
      }
      for (let number = 1; number <= 38; number++) {
        // A27 to A29 are the owner's checks of step N, by eye.
        if (number >= 27 && number <= 29) continue;
        const assumption = `A${String(number)}`;
        // A7 is not checked: nothing relies on it.
        const verdict = assumption === 'A7' ? 'NOT ATTEMPTED' : 'PASS';
        expect(output).toMatch(new RegExp(`^${assumption}: ${verdict}$`, 'm'));
      }
      // A13: the counts on the log, and the failed step's own part with the broken link.
      expect(output).toMatch(/with a timestamp: (\d+), ##\[group\]: \d+, ##\[error\]: 1/);
      expect(output).toContain(
        'byte order mark at the start: no; escape characters (colour codes): 0',
      );
      expect(output).toContain(
        'post steps: Post Run actions/setup-node@v7.0.0 skipped, Post Run actions/checkout@v7.0.1 success; Complete job: success',
      );
      expect(output).toMatch(
        /excerpt of "Check documentation links": cut by the step, \d+ lines; holds orchestrator-smoke-missing\.md: yes/,
      );
      expect(output).toContain(`Step "Check documentation links": its part of the job's log.`);
      // The daemon's reading of each diverged push, with Git's words.
      expect(output).toMatch(/the daemon's reading: diverged[\s\S]*fetch first/);
      expect(output).toMatch(/the daemon's reading: diverged[\s\S]*non-fast-forward/);
      // Each wait says what to click, with the link.
      expect(output).toContain(`1. Open ${github.url}/octo-owner/smoke-test/pull/1`);
      expect(output).toContain('choose "Create a merge commit"');
      expect(output).toContain(`1. Open ${github.url}/octo-owner/smoke-test/pull/2`);
      expect(output).toContain('click "Close pull request"');
      expect(output).toContain(
        'set "Contents" to "Read and write". Change nothing else: not "Workflows".',
      );
      expect(output).toContain('Do not click "Regenerate token"');
      expect(output).toMatch(/at most 30 minutes \(--owner-wait-minutes\)/);
      // The second token's pushes, read by the daemon.
      expect(output).toMatch(/PASS {2}A3: a push without Contents write: refused/);
      expect(output).toMatch(
        /PASS {2}A2: a push adding \.github\/workflows\/orchestrator-smoke\.yml/,
      );
      // The result block: notes, what is left, what stays by design, the version.
      expect(output).toMatch(
        /^Step 8: merged by a merge commit; the default branch's new head [0-9a-f]{40} has 2 parent\(s\)/m,
      );
      expect(output).toContain('Step 9: CI runs started on the second pull request: none.');
      expect(output).toMatch(/Nothing of this run is left on GitHub\.\nStays on GitHub by design:/);
      expect(output).toMatch(/- pull request #1, merged, with the comment reviews of step 6: /);
      expect(output).toMatch(/- pull request #2, closed, with the comment review of step 9: /);
      expect(output).toMatch(
        /- the merge of pull request #1 into main \(a merge commit\), with docs\/orchestrator-smoke\.md: /,
      );
      expect(output).toMatch(/^Script: [0-9a-f]{40}( with local changes)?$/m);
      expect(output).toMatch(/^Git: \d+\.\d+/m);
      expect(output).toMatch(
        /===== End of the result =====\nDelete the tokens you made for this check now/,
      );
      expect(code).toBe(0);

      // What GitHub holds afterwards.
      expect(github.pullRequest(repo, 1)).toMatchObject({ state: 'closed', merged: true });
      // Step 6: without commit_id, then on the head, an older commit and a commit not in it (A11,
      // A30); step 9: on the closed pull request (A31). Lot 3 step H3.
      const reviews = github.pullRequest(repo, 1).reviews;
      expect(reviews.map((review) => review.state)).toEqual([
        'COMMENTED',
        'COMMENTED',
        'COMMENTED',
        'COMMENTED',
      ]);
      expect(new Set(reviews.map((review) => review.commitId)).size).toBe(3);
      expect(github.pullRequest(repo, 2)).toMatchObject({ state: 'closed', merged: false });
      expect(github.pullRequest(repo, 2).reviews.map((review) => review.state)).toEqual([
        'COMMENTED',
      ]);
      for (const assumption of ['A11', 'A30', 'A31']) {
        expect(output).toMatch(new RegExp(`^${assumption}: PASS$`, 'm'));
      }
      expect(output).toMatch(
        /GitHub's answer for a commit not in the pull request \([0-9a-f]{7}\): accepted/,
      );
      expect([...github.branches(repo).keys()]).toEqual(['main']);
      // Steps 3 to 5 and 8: three pull_request runs and the merge's push run. Step 11: the two
      // pull requests to merge, the squash one again after Update branch, and the push runs of
      // both merges; none for the pull request based on the squash branch, which conflicts.
      const events = github.runs(repo).map((each) => each.event);
      expect(events.filter((event) => event === 'pull_request')).toHaveLength(6);
      expect(events.filter((event) => event === 'push')).toHaveLength(3);
      expect(
        github.runs(repo).some((each) => each.headSha === github.pullRequest(repo, 5).headSha),
      ).toBe(false);

      // Step 11 (lot 3 step J4c): squash and rebase, Update branch, the lists and the reads.
      expect(github.pullRequest(repo, 3)).toMatchObject({ state: 'closed', merged: true });
      expect(github.pullRequest(repo, 4)).toMatchObject({ state: 'closed', merged: true });
      expect(github.pullRequest(repo, 5)).toMatchObject({ state: 'closed', merged: false });
      expect(github.pullRequest(repo, 5).base).toMatch(/^orchestrator-smoke-\S+-squash-merge$/);
      expect(output).toContain(`1. Open ${github.url}/octo-owner/smoke-test/pull/4`);
      expect(output).toContain(
        'Your turn on GitHub: merge pull request #4 with "Rebase and merge".',
      );
      expect(output).toContain('choose "Rebase and merge"');
      expect(output).toContain('Click "Rebase and merge", then "Confirm rebase and merge".');
      expect(output).toContain(
        'Your turn on GitHub: merge pull request #3 with "Squash and merge".',
      );
      expect(output).toContain('Click "Squash and merge", then "Confirm squash and merge".');
      expect(output).toMatch(
        /PASS {2}A37: git\/ref\/heads\/orchestrator-smoke-\S+-squash, which only \S+-squash-merge starts with: 404/,
      );
      expect(output).toMatch(/PASS {2}A34: pulls\?base=\S+-squash-merge finds pull request #5/);
      expect(output).toMatch(/PASS {2}A36: PATCH state=closed closes pull request #5/);
      expect(output).toMatch(
        /PASS {2}A32: the open list \(every page\) holds pull requests #3 and #4/,
      );
      expect(output).toMatch(
        /PASS {2}A32: after the merges, the open list no longer holds pull requests #3 and #4/,
      );
      expect(output).toMatch(/PASS {2}A33: after a rebase merge: merged true/);
      expect(output).toMatch(/PASS {2}A33: after a squash merge: merged true/);
      expect(output).toMatch(
        // GitHub's default for a one-commit pull request (the owner's run of 2026-10-16).
        /PASS {2}A21: the squash commit's message: "Orchestrator smoke test: merged by squash \(#3\)", its one commit's title with " \(#3\)"/,
      );
      expect(output).toMatch(
        /PASS {2}A35: branch orchestrator-smoke-\S+-rebase-merge read after its deletion/,
      );
      expect(output).toMatch(
        // Everything the default branch got since step 1: step 8's merge (three commits and the
        // merge commit), the two rebased commits, then Update branch's merge commit.
        /^Step 11: after Update branch, the comparison reads status ahead with 7 commits: .*[0-9a-f]{7} "Orchestrator smoke test: merged by rebase, 2 of 2", [0-9a-f]{7} "Merge branch 'main' into orchestrator-smoke-\S+-squash-merge"\.$/m,
      );
      expect(output).toMatch(/^Step 11: pull request #4 merged by a rebase; /m);
      expect(output).toMatch(/^Step 11: pull request #3 merged by a squash commit; /m);
      expect(output).toMatch(
        /- the rebase of pull request #4 into main, with docs\/orchestrator-smoke-rebase\.md: /,
      );
      expect(output).toMatch(
        /- the squash of pull request #3 into main, with docs\/orchestrator-smoke-squash\.md: /,
      );
      expect(output).toMatch(/- pull request #5, closed \(A34, A36\): /);
      // The log was downloaded without the API's Authorization (A13).
      expect(github.logRequests.length).toBeGreaterThan(0);
      expect(github.logRequests.every((request) => request.authorization === undefined)).toBe(true);
    },
    TIMEOUT,
  );

  it(
    'without the second token, step 10 and its assumptions are not attempted',
    async () => {
      const stopActions = playActions();
      const { child, finished } = start(dryRun(), `yes\n${TOKEN}\n`);
      playOwner(child);
      const { code, output } = await finished;
      stopActions();
      for (const step of [1, 2, 3, 4, 5, 6, 7, 8, 9, 11]) {
        expect(output, output).toContain(`Step ${String(step)}: PASS`);
      }
      expect(output).toContain('Step 10: NOT ATTEMPTED (no second token: add --restricted-token');
      for (const assumption of ['A2', 'A3', 'A7', 'A23']) {
        expect(output).toMatch(new RegExp(`^${assumption}: NOT ATTEMPTED$`, 'm'));
      }
      expect(output).toMatch(/Delete the token you made for this check now/);
      expect(code).toBe(0);
    },
    TIMEOUT,
  );

  it(
    'detects a squash merge as a merge and says so',
    async () => {
      const stopActions = playActions();
      const { child, finished } = start(dryRun(), `yes\n${TOKEN}\n`);
      playOwner(child, { merge: 'squash' });
      const { code, output } = await finished;
      stopActions();
      expect(output, output).toContain('Step 8: PASS');
      expect(output).toMatch(
        /^Step 8: merged by a squash commit; .* has 1 parent\(s\) and the message "Orchestrator smoke test \S+ \(#1\)"/m,
      );
      // Three commits: the pull request's title.
      expect(output).toMatch(
        /PASS {2}A21: the squash commit's message: "Orchestrator smoke test \S+ \(#1\)", the pull request's title with " \(#1\)"/,
      );
      expect(output).toContain('Step 9: PASS');
      expect(code).toBe(0);
    },
    TIMEOUT,
  );

  it(
    'goes on to step 10 when the owner closes the first pull request instead of merging it',
    async () => {
      github.accounts.set(RESTRICTED_TOKEN, restrictedAccount());
      const stopActions = playActions();
      const { child, finished } = start(
        [...dryRun(), '--restricted-token'],
        `yes\n${TOKEN}\n${RESTRICTED_TOKEN}\n`,
      );
      // Closed on GitHub without merging, as the owner could.
      playOwner(child, { merge: 'close' });
      const { code, output } = await finished;
      stopActions();
      expect(output, output).toMatch(/FAIL {2}pull request #1 was closed without merging/);
      expect(output).toMatch(/PASS {2}A20: a pull request closed without merging reads/);
      expect(output).toMatch(/^Step 8: FAIL/m);
      expect(output).toMatch(/^Step 9: NOT ATTEMPTED/m);
      expect(output).toMatch(/^Step 10: PASS/m);
      expect(output).toContain('Step 8: you closed pull request #1 without merging it.');
      expect(output).toMatch(/Nothing of this run is left on GitHub\./);
      expect(code).toBe(1);
      expect(github.pullRequest(repo, 1)).toMatchObject({ state: 'closed', merged: false });
      // No conflicting pull request of step 9: the next one is step 11's.
      expect(github.pullRequest(repo, 2).head).toMatch(/-squash-merge$/);
      expect(output).toMatch(/^Step 11: PASS/m);
      expect([...github.branches(repo).keys()]).toEqual(['main']);
    },
    TIMEOUT,
  );

  it(
    'goes on when the owner does nothing: the waits run out, the script closes what it opened',
    async () => {
      github.accounts.set(RESTRICTED_TOKEN, restrictedAccount());
      const stopActions = playActions();
      const { child, finished } = start(
        [...dryRun(), '--restricted-token', '--owner-wait-minutes', '1'],
        `yes\n${TOKEN}\n${RESTRICTED_TOKEN}\n`,
      );
      playOwner(child, { merge: 'nothing', token: 'nothing', rebase: 'nothing' });
      const { code, output } = await finished;
      stopActions();
      expect(output, output).toMatch(/FAIL {2}pull request #1 was not merged within 1 minutes/);
      expect(output).toContain('The script closed pull request #1.');
      expect(output).toMatch(/^Step 9: NOT ATTEMPTED/m);
      expect(output).toMatch(/NOT ATTEMPTED {2}A2: Contents write was not given within 1 minutes/);
      expect(output).toMatch(/^A2: NOT ATTEMPTED$/m);
      expect(output).toMatch(/^A3: PASS$/m);
      // Step 11: the rebase wait runs out too; the script closes both of its pull requests.
      expect(output).toMatch(/FAIL {2}pull request #3 was not merged within 1 minutes/);
      expect(output).toMatch(/NOT ATTEMPTED {2}A38: it needs the rebase merge/);
      expect(output).toMatch(/^Step 11: FAIL/m);
      expect(output).toMatch(/Nothing of this run is left on GitHub\./);
      expect(output).not.toContain(RESTRICTED_PROBE);
      expect(code).toBe(1);
      for (const number of [2, 3, 4]) {
        expect(github.pullRequest(repo, number)).toMatchObject({ state: 'closed', merged: false });
      }
      expect(github.pullRequest(repo, 1)).toMatchObject({ state: 'closed', merged: false });
      expect([...github.branches(repo).keys()]).toEqual(['main']);
    },
    TIMEOUT,
  );

  it(
    'says when the second pull request is not closed in time, or its branch is deleted',
    async () => {
      const stopActions = playActions();
      const late = start([...dryRun(), '--owner-wait-minutes', '1'], `yes\n${TOKEN}\n`);
      playOwner(late.child, { close: 'nothing' });
      const first = await late.finished;
      expect(first.output, first.output).toMatch(
        /FAIL {2}pull request #2 was not closed within 1 minutes/,
      );
      expect(first.output).toContain('The script closed pull request #2.');
      // The rest of the step still ran.
      expect(first.output).toMatch(/PASS {2}A8: a closed pull request is found with state=all/);
      expect(first.output).toMatch(/PASS {2}A9: a pull request closed without merging is reopened/);
      expect(first.output).toMatch(/Nothing of this run is left on GitHub\./);
      expect(first.code).toBe(1);
      stopActions();
    },
    TIMEOUT,
  );

  it(
    "skips the reopen when the owner deletes the second pull request's branch",
    async () => {
      const stopActions = playActions();
      const { child, finished } = start(dryRun(), `yes\n${TOKEN}\n`);
      playOwner(child, { close: 'delete-branch' });
      const { code, output } = await finished;
      stopActions();
      expect(output, output).toMatch(
        /NOT ATTEMPTED {2}A9: branch orchestrator-smoke-\S+-conflict was deleted, so a reopen cannot be checked/,
      );
      // A9 still passed at step 8 (a merged pull request is not reopened).
      expect(output).toMatch(/^A9: PASS$/m);
      expect(output).toContain('Step 9: PASS');
      expect(output).toMatch(/Nothing of this run is left on GitHub\./);
      expect(code).toBe(0);
    },
    TIMEOUT,
  );

  it(
    'says when the second token is given Workflows too: the harmless file is pushed, no CI run, branch deleted',
    async () => {
      github.accounts.set(RESTRICTED_TOKEN, restrictedAccount());
      const stopActions = playActions();
      const { child, finished } = start(
        [...dryRun(), '--restricted-token'],
        `yes\n${TOKEN}\n${RESTRICTED_TOKEN}\n`,
      );
      playOwner(child, { token: 'workflows' });
      const { code, output } = await finished;
      stopActions();
      expect(output, output).toMatch(
        /FAIL {2}A2: a push adding a workflow file without Workflows write is refused\n.*GitHub accepted it: the second token has Workflows write/,
      );
      expect(output).toMatch(
        /^Step 10: the workflow file was pushed by mistake \(branch orchestrator-smoke-\S+-workflow, deleted at the clean-up\); CI runs started by it within 30 seconds: none\.$/m,
      );
      expect(output).toMatch(/Nothing of this run is left on GitHub\./);
      expect(code).toBe(1);
      expect([...github.branches(repo).keys()]).toEqual(['main']);
      // The file pushed runs only when started by hand.
      expect(output).not.toContain(RESTRICTED_PROBE);
    },
    TIMEOUT,
  );

  it(
    'reads a regenerated second token as A2 not attempted',
    async () => {
      github.accounts.set(RESTRICTED_TOKEN, restrictedAccount());
      const stopActions = playActions();
      const { child, finished } = start(
        [...dryRun(), '--restricted-token'],
        `yes\n${TOKEN}\n${RESTRICTED_TOKEN}\n`,
      );
      playOwner(child, { token: 'regenerate' });
      const { code, output } = await finished;
      stopActions();
      expect(output, output).toMatch(
        /NOT ATTEMPTED {2}A2: GitHub no longer accepts the second token \(regenerated or deleted\?\)/,
      );
      expect(output).toMatch(/^Step 10: PASS/m);
      expect(code).toBe(0);
    },
    TIMEOUT,
  );

  it('checks the second token before doing anything', async () => {
    const cases: [string, FakeAccount | null, RegExp][] = [
      ['', null, /the second token \(--restricted-token\) was not given/],
      [TOKEN, null, /is the same as the first/],
      [RESTRICTED_TOKEN, null, /was refused by GitHub/],
      [
        RESTRICTED_TOKEN,
        { ...restrictedAccount(), login: 'someone-else', repositories: [] },
        /is of someone-else, not of octo-owner/,
      ],
      [
        RESTRICTED_TOKEN,
        { ...restrictedAccount(), repositories: [] },
        /cannot see octo-owner\/smoke-test/,
      ],
    ];
    for (const [second, account, message] of cases) {
      github.accounts.delete(RESTRICTED_TOKEN);
      if (account) github.accounts.set(RESTRICTED_TOKEN, account);
      const { code, output } = await run(
        [...dryRun(), '--restricted-token'],
        `yes\n${TOKEN}\n${second}\n`,
      );
      expect(output).toMatch(message);
      expect(output).toMatch(/Nothing was done on GitHub\./);
      expect(output).not.toContain(PROBE);
      expect(output).not.toContain(RESTRICTED_PROBE);
      expect(code).toBe(3);
    }
    expect(github.requests.every((request) => request.method === 'GET')).toBe(true);
    expect(github.gitRequests).toEqual([]);
  });

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

  it(
    'goes on after an unreadable 201, naming the fields, and cleans the pull request it found',
    async () => {
      // GitHub creates the pull request, but answers a body the layer cannot read (as the
      // owner's first runs did): the script finds it by its branch, fails step 2 naming the
      // field, and runs every later step.
      github.alter = unreadableFirstPullRequest();
      const stopActions = playActions();
      const { child, finished } = start(dryRun(), `yes\n${TOKEN}\n`);
      playOwner(child);
      const { code, output } = await finished;
      stopActions();
      expect(output, output).toMatch(
        /FAIL {2}open the pull request: GitHub answered HTTP 201, but the answer cannot be read/,
      );
      expect(output).toContain('head: expected object, received nothing');
      expect(output).toMatch(/Pull request #1: /);
      expect(output).toMatch(/NOT ATTEMPTED {2}A5: the creation answer could not be read/);
      // The result block names the field under the failed step.
      expect(output).toMatch(
        /^Step 2: FAIL .*\n {6}\| open the pull request: .*\n.*head: expected object, received nothing/m,
      );
      for (const step of [1, 3, 4, 5, 6, 7, 8, 9]) {
        expect(output).toContain(`Step ${String(step)}: PASS`);
      }
      expect(output).toMatch(/^A6: PASS$/m);
      expect(output).toMatch(/Nothing of this run is left on GitHub\./);
      expect(output).not.toContain(PROBE);
      expect(code).toBe(1);
      expect(github.pullRequest(repo, 1)).toMatchObject({ state: 'closed', merged: true });
      expect([...github.branches(repo).keys()]).toEqual(['main']);
    },
    TIMEOUT,
  );

  it(
    'goes on after unreadable answers in steps 6 to 9, naming the fields',
    async () => {
      // A comment review posted, and the pull request read while waiting for the merge, each
      // answered with a body the layer cannot read: the steps fail naming the fields, the merge
      // is still detected ("Check if merged"), and every later step runs.
      github.alter = (request, reply) => {
        const body = reply.body as Record<string, unknown> | undefined;
        if (
          request.method === 'POST' &&
          request.path.endsWith('/reviews') &&
          reply.status === 200
        ) {
          return { ...reply, body: { ...body, state: null } };
        }
        if (
          request.method === 'GET' &&
          request.path.endsWith('/pulls/1') &&
          body?.state === 'closed'
        ) {
          return { ...reply, body: { ...body, merged: 'yes' } };
        }
        return reply;
      };
      const stopActions = playActions();
      const { child, finished } = start(dryRun(), `yes\n${TOKEN}\n`);
      playOwner(child);
      const { code, output } = await finished;
      stopActions();
      expect(output, output).toMatch(
        /FAIL {2}post a comment review: GitHub answered HTTP 200, but the answer cannot be read/,
      );
      expect(output).toContain('state: expected string, received null');
      // The reviews with commit_id of step H3 too, without a verdict on A11, A30 or A31.
      expect(output).toMatch(
        /FAIL {2}post a comment review on the head commit: GitHub answered HTTP 200, but the answer cannot be read/,
      );
      expect(output).toMatch(
        /FAIL {2}post a comment review on the closed pull request: GitHub answered HTTP 200, but the answer cannot be read/,
      );
      expect(output).not.toMatch(/^A3[01]: FAIL/m);
      expect(output).toMatch(
        /FAIL {2}read pull request #1: GitHub answered HTTP 200, but the answer cannot be read/,
      );
      expect(output).toContain('merged: expected boolean, received a string');
      expect(output).toMatch(/^Step 6: FAIL/m);
      expect(output).toMatch(/^Step 8: FAIL/m);
      expect(output).toMatch(/^Step 8: merged by a merge commit/m);
      // Step 9's comment review on the closed pull request is unreadable too (step H3).
      expect(output).toMatch(/^Step 9: FAIL/m);
      expect(output).toMatch(/Nothing of this run is left on GitHub\./);
      expect(code).toBe(1);
      expect([...github.branches(repo).keys()]).toEqual(['main']);
    },
    TIMEOUT,
  );

  it(
    'lists a pull request created with an unreadable 201 among what it left, when it stops',
    async () => {
      github.alter = unreadableFirstPullRequest();
      // No workflow: CI never finishes, and the script stops at step 3.
      repo.workflows = [];
      const { code, output } = await run(
        [...dryRun(), '--ci-wait-minutes', '1'],
        `yes\n${TOKEN}\n`,
      );
      expect(output, output).toMatch(/STOPPED at step 3\./);
      expect(output).toMatch(/^Step 2: FAIL/m);
      expect(output).toMatch(/Left on GitHub by this run, to remove by hand:/);
      expect(output).toContain(`- pull request #1: ${github.url}/octo-owner/smoke-test/pull/1`);
      expect(output).toMatch(/- branch orchestrator-smoke-\S+: /);
      expect(code).toBe(1);
      expect(github.pullRequest(repo, 1).state).toBe('open');
    },
    TIMEOUT,
  );

  it(
    'stops when the pull request it created cannot be found either, saying it is left',
    async () => {
      const first = unreadableFirstPullRequest();
      // The list of the branch's pull requests cannot be read either.
      github.alter = (request, reply) =>
        request.method === 'GET' && /\/pulls\?/.test(request.path)
          ? { ...reply, body: (reply.body as Record<string, unknown>[]).map(() => ({})) }
          : first(request, reply);
      const { code, output } = await run(dryRun(), `yes\n${TOKEN}\n`);
      expect(output, output).toMatch(
        /FAIL {2}find the pull request of branch orchestrator-smoke-\S+: GitHub answered HTTP 200, but the answer cannot be read/,
      );
      expect(output).toContain('0.number: expected number, received nothing');
      expect(output).toMatch(/STOPPED at step 2\./);
      expect(output).toMatch(
        /- a pull request from branch orchestrator-smoke-\S+, whose number could not be read: .*\/octo-owner\/smoke-test\/pulls\?q=is%3Apr%20is%3Aopen%20head%3Aorchestrator-smoke-/,
      );
      expect(output).toMatch(/- branch orchestrator-smoke-\S+: /);
      expect(code).toBe(1);
      expect(github.pullRequest(repo, 1).state).toBe('open');
    },
    TIMEOUT,
  );

  it('stops before anything is made when squash or rebase merging is off, naming the box', async () => {
    const cases: [Partial<FakeRepository>, string][] = [
      [
        { allowSquashMerge: false },
        'does not allow squash merging. Open REPO/settings and, under "Pull Requests", tick "Allow squash merging"',
      ],
      [
        { allowRebaseMerge: false },
        'does not allow rebase merging. Open REPO/settings and, under "Pull Requests", tick "Allow rebase merging"',
      ],
      [
        { allowSquashMerge: false, allowRebaseMerge: false },
        'does not allow either. Open REPO/settings and, under "Pull Requests", tick "Allow squash merging" and "Allow rebase merging"',
      ],
    ];
    for (const [settings, words] of cases) {
      Object.assign(repo, { allowSquashMerge: true, allowRebaseMerge: true }, settings);
      const { code, output } = await run(dryRun(), `yes\n${TOKEN}\n`);
      expect(output).toContain(
        `STOPPED: step 11 asks you to merge one pull request by squash and one by rebase, and octo-owner/smoke-test ${words.replace('REPO', `${github.url}/octo-owner/smoke-test`)} (GitHub saves it at once), then run the script again. Nothing was done on GitHub.`,
      );
      expect(output).not.toContain(PROBE);
      expect(code).toBe(3);
    }
    expect(github.requests.every((request) => request.method === 'GET')).toBe(true);
    expect(github.gitRequests).toEqual([]);
  });

  it(
    'says when GitHub hides the merge settings, and fails step 11 when the owner merges another way',
    async () => {
      // GitHub may leave the settings out of a token's answer: the script says to check them.
      github.alter = (request, reply) => {
        if (request.method !== 'GET' || request.path !== '/repos/octo-owner/smoke-test') {
          return reply;
        }
        const body = { ...(reply.body as Record<string, unknown>) };
        delete body.allow_squash_merge;
        delete body.allow_rebase_merge;
        return { ...reply, body };
      };
      const stopActions = playActions();
      const { child, finished } = start(dryRun(), `yes\n${TOKEN}\n`);
      // "Squash and merge" where the script asked for "Rebase and merge".
      playOwner(child, { rebase: 'squash' });
      const { code, output } = await finished;
      stopActions();
      expect(output, output).toContain(
        `GitHub did not say whether octo-owner/smoke-test allows squash and rebase merging: before step 11, check that "Allow squash merging" and "Allow rebase merging" are ticked under "Pull Requests" in its settings: ${github.url}/octo-owner/smoke-test/settings`,
      );
      expect(output).toMatch(
        /FAIL {2}pull request #4 merged by a rebase\n {6}\| GitHub's default branch shows a squash commit/,
      );
      expect(output).toMatch(/^Step 11: pull request #4 merged by a squash commit; /m);
      // The rest of the step still runs: A33 holds whatever the method, and Update branch.
      expect(output).toMatch(/PASS {2}A33: after a rebase merge/);
      expect(output).toMatch(/PASS {2}A38: /);
      expect(output).toMatch(/^Step 11: FAIL/m);
      expect(output).toMatch(/Nothing of this run is left on GitHub\./);
      expect(code).toBe(1);
      expect([...github.branches(repo).keys()]).toEqual(['main']);
    },
    TIMEOUT,
  );

  it(
    'fails step 11 naming the box when rebase merging is turned off during the run, and cleans up',
    async () => {
      const stopActions = playActions();
      const { child, finished } = start(dryRun(), `yes\n${TOKEN}\n`);
      playOwner(child);
      void waitForOutput(child, 'Your turn on GitHub: close pull request #2').then(() => {
        repo.allowRebaseMerge = false;
      });
      const { code, output } = await finished;
      stopActions();
      expect(output, output).toContain(
        `FAIL  "Allow rebase merging" is not ticked any more: Open ${github.url}/octo-owner/smoke-test/settings and, under "Pull Requests", tick "Allow rebase merging" (GitHub saves it at once), then run the script again`,
      );
      expect(output).toMatch(/^Step 11: FAIL/m);
      expect(output).toMatch(/^A32: NOT ATTEMPTED$/m);
      expect(output).toMatch(/Nothing of this run is left on GitHub\./);
      expect(code).toBe(1);
      expect(() => github.pullRequest(repo, 3)).toThrow();
      expect([...github.branches(repo).keys()]).toEqual(['main']);
    },
    TIMEOUT,
  );

  it(
    'says what step 11 left on GitHub when stopped with Ctrl+C during its wait',
    async () => {
      const stopActions = playActions();
      const { child, finished } = start(dryRun(), `yes\n${TOKEN}\n`);
      playOwner(child, { rebase: 'nothing' });
      await waitForOutput(child, 'with "Rebase and merge".');
      process.kill(-(child.pid ?? 0), 'SIGINT');
      const { code, output } = await finished;
      stopActions();
      expect(output, output).toMatch(/Left on GitHub by this run, to remove by hand:/);
      for (const number of [3, 4]) {
        expect(output).toContain(
          `- pull request #${String(number)}: ${github.url}/octo-owner/smoke-test/pull/${String(number)} ("Close pull request" at the bottom of its page`,
        );
      }
      // Pull request #5 is closed already (A36).
      expect(output).not.toMatch(/- pull request #5:/);
      for (const suffix of ['', '-conflict', '-squash-merge', '-rebase-merge', '-base-list']) {
        expect(output).toMatch(
          new RegExp(
            `- branch orchestrator-smoke-\\d{8}-\\d{6}Z${suffix}: .*/branches \\(the bin icon on its line\\)`,
          ),
        );
      }
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

  it.each([
    ['the token', 'Paste the token', []],
    ['the second token', 'Paste the second, restricted token', ['--restricted-token']],
  ])(
    "gives the terminal's echo back when Ctrl+C comes while %s is typed",
    async (_which, prompt, extra) => {
      // `script` gives the command a terminal; `stty -a` then reads that terminal's settings.
      const command = [
        'bash',
        `'${script}'`,
        ...[...dryRun(), ...extra].map((arg) => `'${arg}'`),
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
          if (prompt === 'Paste the token') setTimeout(() => child.stdin.write('\x03'), 300);
          else child.stdin.write('\r');
        }
        if (step === 2 && output.includes(prompt) && prompt !== 'Paste the token') {
          step = 3;
          child.stdin.write(RESTRICTED_PROBE.slice(0, 10));
          setTimeout(() => child.stdin.write('\x03'), 300);
        }
      });
      await new Promise((done) => child.on('close', done));
      expect(output).toMatch(/EXIT=3/);
      // `-echo` would mean the echo was left off.
      expect(output).toMatch(/[ \n]echo[ \r\n]/);
      expect(output).not.toMatch(/-echo[ \r\n]/);
      expect(output).not.toContain(PROBE.slice(0, 10));
      expect(output).not.toContain(RESTRICTED_PROBE.slice(0, 10));
      await nothingDone();
    },
    TIMEOUT,
  );
});

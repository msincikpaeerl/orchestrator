import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  BRANCH_REPORT_COMMITS_MAX_BYTES,
  CHANGED_FILES_MAX_BYTES,
  COMMIT_SUBJECT_MAX_CHARACTERS,
  CUT_MARKER,
  encodedBytes,
} from '@orchestrator/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Git } from '../src/git.js';
import { localBranches } from '../src/local-branches.js';
import { TrustRegistry } from '../src/trust.js';
import { Workspaces } from '../src/workspace.js';
import { createRemote, gitIn } from './remote.js';
import { prepareTicketRun, runStartPayload } from './run-start.js';
import {
  DAEMON_COMMAND,
  captureLogger,
  createTestHome,
  fakeExecutable,
  linkSystemTool,
  type TestHome,
} from './testing.js';

// The facts of a `ticket_submit` (05, section 4.9; lot 3 step F) with the real Git: the files
// the branch changed against the base branch, as GitHub's "Files changed" tab compares them, and
// the budgets that keep the facts within one message (04, section 8). No program named in a
// configuration an agent can change starts while they are read (ADR 0034's lesson).

let home: TestHome;
let workspaces: Workspaces;
let remote: string;

beforeEach(async () => {
  home = await createTestHome();
  await linkSystemTool(home.bin, 'git');
  const remotes = join(home.root, 'remotes');
  remote = await createRemote(remotes, 'owner', 'notes', home.env);
  workspaces = new Workspaces({
    paths: home.paths,
    git: new Git(join(home.bin, 'git'), home.env),
    trust: new TrustRegistry(join(home.paths.claudeConfig, '.claude.json')),
    credentials: () => Promise.reject(new Error('no credential for a file:// remote')),
    selfCommand: DAEMON_COMMAND,
    log: captureLogger().log,
  });
});
afterEach(async () => {
  await home.remove();
});

async function prepare() {
  const start = runStartPayload(`file://${remote}`);
  const folder = join(home.paths.home, 'runs', start.runId);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  return { start, ...(await prepareTicketRun(workspaces, start, folder)) };
}

type Prepared = Awaited<ReturnType<typeof prepare>>;

async function facts(prepared: Prepared) {
  const read = await workspaces.facts(
    prepared.bare,
    prepared.worktree,
    prepared.start.repository,
    prepared.start.runId,
  );
  if (!read) throw new Error('no facts');
  return read;
}

/** Writes (or deletes, for null) `files` in `folder`, then commits them all. */
async function commit(
  folder: string,
  files: Record<string, string | null>,
  message: string,
): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) {
      await rm(join(folder, path));
    } else {
      await mkdir(dirname(join(folder, path)), { recursive: true });
      await writeFile(join(folder, path), content);
    }
  }
  gitIn(folder, ['add', '-A'], home.env);
  gitIn(folder, ['commit', '--quiet', '-m', message], home.env);
}

/**
 * A new commit on GitHub's base branch, as the machine fetched it: `refs/remotes/origin/main`
 * of the bare clone moves to it, as after the daemon's fetch at a run's preparation.
 */
async function moveBase(bare: string, files: Record<string, string | null>): Promise<void> {
  const other = join(home.root, `base-${randomUUID()}`);
  gitIn(bare, ['worktree', 'add', '--quiet', '--detach', other, 'refs/remotes/origin/main'], {
    ...home.env,
  });
  await commit(other, files, 'A change on main');
  const head = gitIn(other, ['rev-parse', 'HEAD'], home.env).trim();
  gitIn(bare, ['update-ref', 'refs/remotes/origin/main', head], home.env);
  gitIn(bare, ['worktree', 'remove', '--force', other], home.env);
}

function merge(worktree: string): void {
  gitIn(worktree, ['merge', '--quiet', '--no-edit', 'origin/main'], home.env);
}

describe('the files the branch changed', () => {
  it('lists added, changed and deleted files and both paths of a rename, not what the merged base brought', async () => {
    const prepared = await prepare();
    await moveBase(prepared.bare, { 'old.md': 'old\n', 'gone.md': 'gone\n' });
    merge(prepared.worktree);
    gitIn(prepared.worktree, ['mv', 'old.md', 'new.md'], home.env);
    await commit(
      prepared.worktree,
      { 'gone.md': null, 'README.md': '# notes, changed\n', 'docs/a b.md': 'spaces\n' },
      'Change, delete, rename and add',
    );
    expect((await facts(prepared)).changedFiles).toEqual({
      listed: ['README.md', 'docs/a b.md', 'gone.md', 'new.md', 'old.md'],
      count: 5,
    });
  });

  it('lists only the branch own files after the base was merged twice and moved again', async () => {
    const prepared = await prepare();
    await commit(prepared.worktree, { 'a.md': 'a\n' }, 'Add a');
    await moveBase(prepared.bare, { 'b1.md': 'b1\n' });
    merge(prepared.worktree);
    await commit(prepared.worktree, { 'c.md': 'c\n' }, 'Add c');
    await moveBase(prepared.bare, { 'b2.md': 'b2\n', 'README.md': '# notes on main\n' });
    merge(prepared.worktree);
    // Moved again, not merged: the branch still changed only its own files.
    await moveBase(prepared.bare, { 'b3.md': 'b3\n' });
    expect((await facts(prepared)).changedFiles).toEqual({ listed: ['a.md', 'c.md'], count: 2 });
  });

  it('lists every file of the branch when the base branch was never fetched', async () => {
    const prepared = await prepare();
    await commit(prepared.worktree, { 'a.md': 'a\n' }, 'Add a');
    gitIn(prepared.bare, ['update-ref', '-d', 'refs/remotes/origin/main'], home.env);
    expect((await facts(prepared)).changedFiles).toEqual({
      listed: ['README.md', 'a.md'],
      count: 2,
    });
  });

  it('lists the files that fit the budget, the first in order, and counts them all', async () => {
    const prepared = await prepare();
    // 1,291 paths of 200 characters (202 bytes each in JSON) and a last one of 67: the list's
    // encoding, brackets and commas included, is exactly the budget.
    const paths = Array.from(
      { length: 1291 },
      (_, n) => `f/${String(n).padStart(4, '0')}${'x'.repeat(194)}`,
    );
    const last = `g/${'y'.repeat(65)}`;
    expect(encodedBytes([...paths, last])).toBe(CHANGED_FILES_MAX_BYTES);
    await commit(
      prepared.worktree,
      Object.fromEntries([...paths, last].map((path) => [path, '\n'])),
      'Many files',
    );
    expect((await facts(prepared)).changedFiles).toEqual({ listed: [...paths, last], count: 1292 });
    // One character more: the last file no longer fits; it is still counted.
    await commit(prepared.worktree, { [`${last}z`]: '\n', [last]: null }, 'One character more');
    expect((await facts(prepared)).changedFiles).toEqual({ listed: paths, count: 1292 });
  });
});

describe('the commits of the facts', () => {
  it('cuts a subject at its limit with the marker', async () => {
    const prepared = await prepare();
    await commit(prepared.worktree, { 'a.md': 'a\n' }, 'x'.repeat(1500));
    const subject = (await facts(prepared)).branch.commitsAhead[0]?.subject ?? '';
    expect(subject).toHaveLength(COMMIT_SUBJECT_MAX_CHARACTERS);
    expect(subject.endsWith(CUT_MARKER)).toBe(true);
  });

  it('lists the newest commits that fit the budget, and counts them all as not on GitHub', async () => {
    const prepared = await prepare();
    const subject = 's'.repeat(COMMIT_SUBJECT_MAX_CHARACTERS);
    gitIn(prepared.worktree, ['commit', '--quiet', '--allow-empty', '-m', 'first'], home.env);
    for (let n = 0; n < 300; n++) {
      gitIn(prepared.worktree, ['commit', '--quiet', '--allow-empty', '-m', subject], home.env);
    }
    const head = gitIn(prepared.worktree, ['rev-parse', 'HEAD'], home.env).trim();
    const { branch } = await facts(prepared);
    expect(branch.commitsAhead.length).toBeLessThan(301);
    expect(branch.commitsAhead[0]?.hash).toBe(head);
    expect(encodedBytes(branch.commitsAhead)).toBeLessThanOrEqual(BRANCH_REPORT_COMMITS_MAX_BYTES);
    expect(
      encodedBytes(branch.commitsAhead) + encodedBytes(branch.commitsAhead[0]) + 1,
    ).toBeGreaterThan(BRANCH_REPORT_COMMITS_MAX_BYTES);
    expect(branch.notOnGitHub).toEqual({
      listed: branch.commitsAhead.map((each) => each.hash),
      count: 301,
    });
  });
});

describe('no program named in an agent-changed configuration starts', () => {
  it('while the facts are read: external diff, text conversion, pager, hooks, file system monitor, signature check', async () => {
    const prepared = await prepare();
    const { bare, worktree } = prepared;
    const marker = join(home.root, 'started');
    const spy = await fakeExecutable(home.root, 'spy', `echo "$0 $*" >> '${marker}'`);
    // A program standing for gpg: signs when the agent commits, records any verification.
    const gpg = await fakeExecutable(
      home.root,
      'spy-gpg',
      [
        `case " $* " in *" --verify "*) echo "gpg $*" >> '${marker}' ;; esac`,
        // Reads what Git writes first: exiting before would fail Git's write under load.
        'while read -r line; do :; done',
        "echo '[GNUPG:] SIG_CREATED D 1 8 00 1700000000 0000' >&2",
        "printf -- '-----BEGIN PGP SIGNATURE-----\\n\\nZmFrZQ==\\n-----END PGP SIGNATURE-----\\n'",
      ].join('\n'),
    );
    await commit(worktree, { '.gitattributes': '* diff=spy\n', 'a.md': 'a\n' }, 'Attributes');
    await writeFile(join(worktree, 'b.md'), 'b\n');
    gitIn(worktree, ['add', 'b.md'], home.env);
    gitIn(
      worktree,
      [
        '-c',
        `gpg.program=${gpg}`,
        '-c',
        'user.signingKey=spy',
        'commit',
        '-S',
        '-q',
        '-m',
        'Signed',
      ],
      home.env,
    );
    await rm(marker, { force: true });
    const hooks = join(home.root, 'hooks');
    await mkdir(hooks);
    for (const hook of ['reference-transaction', 'post-index-change', 'post-checkout']) {
      await fakeExecutable(hooks, hook, `echo "hook ${hook}" >> '${marker}'`);
    }
    const planted = [
      ['diff.external', spy],
      ['diff.spy.textconv', spy],
      ['diff.spy.command', spy],
      ['core.pager', spy],
      ['pager.log', spy],
      ['pager.diff-tree', spy],
      ['core.hooksPath', hooks],
      ['core.fsmonitor', spy],
      ['log.showSignature', 'true'],
      ['gpg.program', gpg],
    ];
    for (const [name = '', value = ''] of planted) {
      // In the bare clone's shared configuration, and in the worktree's own.
      gitIn(bare, ['config', name, value], home.env);
      gitIn(worktree, ['config', '--worktree', name, value], home.env);
    }
    const read = await facts(prepared);
    expect(read.changedFiles).toEqual({ listed: ['.gitattributes', 'a.md', 'b.md'], count: 3 });
    expect(read.branch.commitsAhead.map((each) => each.subject)).toEqual(['Signed', 'Attributes']);
    expect(await readFile(marker, 'utf8').catch(() => '')).toBe('');
  });

  it("while `status` lists the machine's branches: a signature check", async () => {
    const prepared = await prepare();
    const marker = join(home.root, 'started');
    const gpg = await fakeExecutable(
      home.root,
      'spy-gpg',
      [
        `case " $* " in *" --verify "*) echo "gpg $*" >> '${marker}' ;; esac`,
        // Reads what Git writes first: exiting before would fail Git's write under load.
        'while read -r line; do :; done',
        "echo '[GNUPG:] SIG_CREATED D 1 8 00 1700000000 0000' >&2",
        "printf -- '-----BEGIN PGP SIGNATURE-----\\n\\nZmFrZQ==\\n-----END PGP SIGNATURE-----\\n'",
      ].join('\n'),
    );
    await writeFile(join(prepared.worktree, 'a.md'), 'a\n');
    gitIn(prepared.worktree, ['add', 'a.md'], home.env);
    gitIn(
      prepared.worktree,
      [
        '-c',
        `gpg.program=${gpg}`,
        '-c',
        'user.signingKey=spy',
        'commit',
        '-S',
        '-q',
        '-m',
        'Signed',
      ],
      home.env,
    );
    gitIn(prepared.bare, ['config', 'log.showSignature', 'true'], home.env);
    gitIn(prepared.bare, ['config', 'gpg.program', gpg], home.env);
    const [repository] = await localBranches(home.paths, new Git(join(home.bin, 'git'), home.env));
    expect(repository?.branches[0]?.notOnGitHub.map((commit) => commit.subject)).toEqual([
      'Signed',
    ]);
    expect(await readFile(marker, 'utf8').catch(() => '')).toBe('');
  });

  it('while the changed files are read: a filter named in the attributes', async () => {
    const prepared = await prepare();
    const marker = join(home.root, 'started');
    const spy = await fakeExecutable(home.root, 'spy', `echo "$0 $*" >> '${marker}'`);
    await commit(
      prepared.worktree,
      { '.gitattributes': '* filter=spy\n', 'a.md': 'a\n' },
      'Filter',
    );
    gitIn(prepared.bare, ['config', 'filter.spy.clean', spy], home.env);
    gitIn(prepared.bare, ['config', 'filter.spy.smudge', spy], home.env);
    gitIn(prepared.bare, ['config', 'filter.spy.process', spy], home.env);
    const head = gitIn(prepared.worktree, ['rev-parse', 'HEAD'], home.env).trim();
    expect(await workspaces.changedFiles(prepared.bare, prepared.start.repository, head)).toEqual({
      listed: ['.gitattributes', 'a.md'],
      count: 2,
    });
    expect(await readFile(marker, 'utf8').catch(() => '')).toBe('');
  });
});

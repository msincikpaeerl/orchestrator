import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ORIGIN_FETCH, restoreBareConfig } from './bare-config.js';
import { GIT_ISOLATION_ENV, Git } from './git.js';

const URL = 'https://github.com/owner/notes.git';
const env = { ...process.env, ...GIT_ISOLATION_ENV };
const git = new Git('git', process.env);

let folder: string;
let bare: string;

function run(args: string[]): string {
  return execFileSync('git', args, { env, encoding: 'utf8' });
}

/** A bare clone set up as `workspace.ts` sets it up. */
beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'od-test-bare-config-'));
  bare = join(folder, 'notes.git');
  run(['init', '--quiet', '--bare', bare]);
  run(['-C', bare, 'remote', 'add', 'origin', URL]);
  run(['-C', bare, 'config', 'remote.origin.fetch', ORIGIN_FETCH]);
  run(['-C', bare, 'config', 'extensions.worktreeConfig', 'true']);
  run(['-C', bare, 'config', '--unset', 'core.bare']);
  run(['-C', bare, 'config', '--worktree', 'core.bare', 'true']);
  run(['-C', bare, 'config', '--replace-all', 'credential.helper', '']);
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

const list = () => run(['config', '--file', join(bare, 'config'), '--list']);

describe('restoreBareConfig', () => {
  it('changes nothing and reports nothing for the configuration the daemon wrote', async () => {
    const before = await readFile(join(bare, 'config'), 'utf8');
    expect(await restoreBareConfig(git, bare, URL)).toBeNull();
    expect(await readFile(join(bare, 'config'), 'utf8')).toBe(before);
  });

  it('keeps the format settings, and masks a credential in a setting name', async () => {
    run([
      '-C',
      bare,
      'config',
      'url.https://x-access-token:ghp_Secret0000000000000000000000000000000@example.com/.insteadOf',
      URL,
    ]);
    run(['-C', bare, 'config', 'core.ignorecase', 'maybe']);
    const said = await restoreBareConfig(git, bare, URL);
    expect(said).toContain('url.https://***@example.com/.insteadof');
    expect(said).toContain('Settings changed, set back: core.ignorecase.');
    expect(said).not.toContain('ghp_Secret');
    expect(list()).toBe(
      [
        'core.repositoryformatversion=0',
        'core.filemode=true',
        'extensions.worktreeconfig=true',
        `remote.origin.url=${URL}`,
        `remote.origin.fetch=${ORIGIN_FETCH}`,
        'credential.helper=',
        '',
      ].join('\n'),
    );
    // Git still reads the repository as before.
    expect(run(['-C', bare, 'rev-parse', '--is-bare-repository']).trim()).toBe('true');
  });

  it('writes a configuration Git cannot read again, and replaces a hooks link', async () => {
    await writeFile(join(bare, 'config'), '[core\n\tbroken');
    await rm(join(bare, 'hooks'), { recursive: true });
    await symlink(folder, join(bare, 'hooks'));
    expect(await restoreBareConfig(git, bare, URL)).toBe(
      'Found changed when the run ended (by this run or an earlier one of the project on this machine), and restored. Hook files added, removed: hooks (not a folder). Files Git could not read, written again: config.',
    );
    expect(list()).toContain(`remote.origin.url=${URL}`);
    expect(await readdir(join(bare, 'hooks'))).toEqual([]);
  });

  it("puts back the bare clone's own per-worktree configuration", async () => {
    run(['-C', bare, 'config', '--worktree', 'core.hooksPath', '/tmp']);
    expect(await restoreBareConfig(git, bare, URL)).toBe(
      'Found changed when the run ended (by this run or an earlier one of the project on this machine), and restored. Settings added, removed: core.hookspath (config.worktree).',
    );
    expect(run(['config', '--file', join(bare, 'config.worktree'), '--list'])).toBe(
      'core.bare=true\n',
    );
  });
});

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// A repository standing for the project's GitHub repository: a bare repository with a `main`
// branch, served through `file://` or the Git HTTP test server.

const AUTHOR = {
  GIT_AUTHOR_NAME: 'Owner',
  GIT_AUTHOR_EMAIL: 'owner@example.com',
  GIT_COMMITTER_NAME: 'Owner',
  GIT_COMMITTER_EMAIL: 'owner@example.com',
};

export function gitIn(cwd: string, args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync('git', args, { cwd, env: { ...env, ...AUTHOR }, encoding: 'utf8' });
}

/**
 * Creates `<root>/<owner>/<name>.git` holding `main` with a README, and optionally more branches
 * with one commit each. Resolves with the bare repository's path.
 */
export async function createRemote(
  root: string,
  owner: string,
  name: string,
  env: NodeJS.ProcessEnv,
  branches: string[] = [],
): Promise<string> {
  const bare = join(root, owner, `${name}.git`);
  await mkdir(join(root, owner), { recursive: true });
  const work = await mkdtemp(join(root, 'source-'));
  gitIn(work, ['init', '--quiet', '--initial-branch=main'], env);
  await writeFile(join(work, 'README.md'), `# ${name}\n`);
  gitIn(work, ['add', 'README.md'], env);
  gitIn(work, ['commit', '--quiet', '-m', 'Initial commit'], env);
  for (const branch of branches) {
    gitIn(work, ['checkout', '--quiet', '-b', branch, 'main'], env);
    await writeFile(join(work, `${branch.replace(/\W/g, '-')}.txt`), `${branch}\n`);
    gitIn(work, ['add', '-A'], env);
    gitIn(work, ['commit', '--quiet', '-m', `Work on ${branch}`], env);
  }
  gitIn(root, ['clone', '--quiet', '--bare', work, bare], env);
  await rm(work, { recursive: true, force: true });
  return bare;
}

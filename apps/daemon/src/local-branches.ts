import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommitSummary } from '@orchestrator/protocol';
import type { Git } from './git.js';
import type { DaemonPaths } from './paths.js';

/** A ticket branch of a bare clone, with its commits on no branch fetched from GitHub. */
export interface LocalBranch {
  name: string;
  head: string;
  /** Newest first. */
  notOnGitHub: CommitSummary[];
}

/** The ticket branches of one bare clone, or why they could not be read. */
export interface LocalRepository {
  /** `owner/name`. */
  repository: string;
  branches: LocalBranch[];
  error: string | null;
}

/**
 * Git without any lock or write: `GIT_OPTIONAL_LOCKS=0` keeps even reading commands from refreshing
 * the index, and only reading commands are run (owner's decision, lot 2 step L2).
 */
const READ_ONLY = { GIT_OPTIONAL_LOCKS: '0' };

async function folders(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * The local ticket branches (`t/*`) of the machine's bare clones (05, section 8): each one's head
 * and its commits not on any branch fetched from GitHub (`refs/remotes/origin/*`), read without a
 * fetch, a lock or a write, so a daemon starting or running meanwhile is never disturbed.
 */
export async function localBranches(paths: DaemonPaths, git: Git): Promise<LocalRepository[]> {
  const repos = join(paths.home, 'repos');
  const found: LocalRepository[] = [];
  for (const owner of await folders(repos)) {
    for (const folder of await folders(join(repos, owner))) {
      if (!folder.endsWith('.git')) continue;
      const bare = join(repos, owner, folder);
      const repository = `${owner}/${folder.slice(0, -'.git'.length)}`;
      try {
        const refs = await git.run(
          [
            '-C',
            bare,
            'for-each-ref',
            '--format=%(refname:strip=2)%00%(objectname)',
            'refs/heads/t/',
          ],
          READ_ONLY,
        );
        const branches: LocalBranch[] = [];
        for (const line of refs.split('\n').filter(Boolean)) {
          const [name = '', head = ''] = line.split('\0');
          const log = await git.run(
            [
              '-C',
              bare,
              'log',
              // `log.showSignature`, set by an agent, would start `gpg.program` (lot 3 step F).
              '--no-show-signature',
              '--format=%H%x00%s',
              `refs/heads/${name}`,
              '--not',
              '--remotes=origin',
            ],
            READ_ONLY,
          );
          branches.push({
            name,
            head,
            notOnGitHub: log
              .split('\n')
              .filter(Boolean)
              .map((entry) => {
                const [hash = '', subject = ''] = entry.split('\0');
                return { hash, subject };
              }),
          });
        }
        found.push({ repository, branches, error: null });
      } catch (error) {
        found.push({
          repository,
          branches: [],
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return found;
}

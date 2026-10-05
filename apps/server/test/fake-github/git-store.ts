import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ISOLATED_GIT_ENV } from '@orchestrator/daemon/testing/git-http-server';

// A bare repository of the fake GitHub, on disk so that `git http-backend` serves the same
// commits the REST API reads and writes. Every command runs without the user's Git configuration
// (no global or system file, HOME in the fake's folder): the owner's credential helpers, hooks and
// aliases never apply.

export interface FakeCommit {
  sha: string;
  message: string;
  tree: string;
  parents: string[];
}

const ZERO = '0000000000000000000000000000000000000000';

/**
 * Refuses a push that adds, changes or deletes a file under `.github/workflows/` unless
 * `FAKE_GITHUB_WORKFLOWS` is `write`: GitHub needs the Workflows permission "to access or edit
 * Actions files in the `.github/workflows` directory" ("Choosing permissions for a GitHub App",
 * https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app).
 * The refusal text is the fake's: confirmed or corrected in lot 3 step E.
 */
const PRE_RECEIVE = `#!/bin/sh
[ "$FAKE_GITHUB_WORKFLOWS" = write ] && exit 0
while read -r old new ref; do
  [ "$new" = ${ZERO} ] && continue
  if [ "$old" = ${ZERO} ]; then
    changed=$(git rev-list "$new" --not --all | while read -r commit; do git diff-tree --root --no-commit-id --name-only -r "$commit"; done)
  else
    changed=$(git diff --name-only "$old" "$new")
  fi
  file=$(printf '%s\\n' "$changed" | grep '^\\.github/workflows/' | head -n 1)
  if [ -n "$file" ]; then
    echo "refusing to allow a Personal Access Token to create or update workflow \\\`$file\\\` without \\\`workflows\\\` permission" >&2
    exit 1
  fi
done
exit 0
`;

export class GitStore {
  private readonly env: NodeJS.ProcessEnv;

  constructor(
    /** The bare repository's folder. */
    readonly path: string,
    home: string,
  ) {
    this.env = {
      ...ISOLATED_GIT_ENV,
      HOME: home,
      PATH: process.env.PATH ?? '',
      LANG: 'C.UTF-8',
      GIT_AUTHOR_NAME: 'Fake GitHub',
      GIT_AUTHOR_EMAIL: 'noreply@example.com',
      GIT_COMMITTER_NAME: 'Fake GitHub',
      GIT_COMMITTER_EMAIL: 'noreply@example.com',
    };
  }

  /** Creates the bare repository with its default branch name and the workflow hook. */
  init(defaultBranch: string): void {
    mkdirSync(this.path, { recursive: true });
    this.git(['init', '--quiet', '--bare', `--initial-branch=${defaultBranch}`]);
    // GitHub accepts pushes from the token's account; `git http-backend` needs this for a user
    // it did not authenticate itself.
    this.git(['config', 'http.receivepack', 'true']);
    const hook = join(this.path, 'hooks', 'pre-receive');
    writeFileSync(hook, PRE_RECEIVE);
    chmodSync(hook, 0o755);
  }

  remove(): void {
    rmSync(this.path, { recursive: true, force: true });
  }

  git(args: string[], input?: string, extraEnv: Record<string, string> = {}): string {
    return execFileSync('git', args, {
      cwd: this.path,
      env: { ...this.env, ...extraEnv },
      encoding: 'utf8',
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  /** Exit code instead of an exception. */
  private status(args: string[]): { code: number; stdout: string } {
    const result = spawnSync('git', args, { cwd: this.path, env: this.env, encoding: 'utf8' });
    return { code: result.status ?? 1, stdout: result.stdout };
  }

  /** Branch name to commit. */
  branches(): Map<string, string> {
    const out = this.git([
      'for-each-ref',
      '--format=%(refname:strip=2) %(objectname)',
      'refs/heads',
    ]);
    return new Map(
      out
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [name = '', sha = ''] = line.split(' ');
          return [name, sha] as const;
        }),
    );
  }

  branch(name: string): string | undefined {
    return this.branches().get(name);
  }

  /** Every ref (branches and tags), full names. */
  refs(): Map<string, string> {
    const out = this.git(['for-each-ref', '--format=%(refname) %(objectname)']);
    return new Map(
      out
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split(' ') as [string, string]),
    );
  }

  /** Sets a branch, only if it still points to `expected` when given (`null`: must not exist). */
  setBranch(name: string, sha: string, expected?: string | null): void {
    const args = ['update-ref', `refs/heads/${name}`, sha];
    if (expected !== undefined) args.push(expected ?? ZERO);
    this.git(args);
  }

  deleteBranch(name: string): void {
    this.git(['update-ref', '-d', `refs/heads/${name}`]);
  }

  commit(sha: string): FakeCommit | undefined {
    if (!/^[0-9a-f]{4,64}$/.test(sha)) return undefined;
    const { code, stdout } = this.status(['cat-file', '-t', sha]);
    if (code !== 0 || stdout.trim() !== 'commit') return undefined;
    const out = this.git(['log', '-1', '--format=%H%x00%T%x00%P%x00%B', sha]);
    const [full = '', tree = '', parents = '', message = ''] = out.split('\0');
    return {
      sha: full,
      tree,
      parents: parents.split(' ').filter(Boolean),
      message: message.replace(/\n+$/, ''),
    };
  }

  isTree(sha: string): boolean {
    if (!/^[0-9a-f]{4,64}$/.test(sha)) return false;
    const { code, stdout } = this.status(['cat-file', '-t', sha]);
    return code === 0 && stdout.trim() === 'tree';
  }

  /** The tree of a tree, a commit or a branch name; undefined when there is none. */
  treeOf(treeish: string): string | undefined {
    if (!/^[\w./-]+$/.test(treeish) || treeish.startsWith('-')) return undefined;
    const { code, stdout } = this.status(['rev-parse', '--verify', '--quiet', `${treeish}^{tree}`]);
    return code === 0 ? stdout.trim() : undefined;
  }

  /** Commits from `sha` following first parents, newest first. */
  history(sha: string): FakeCommit[] {
    const out = this.git(['rev-list', '--first-parent', sha]);
    return out
      .split('\n')
      .filter(Boolean)
      .flatMap((commit) => this.commit(commit) ?? []);
  }

  /** Files of a commit or tree, path to content. */
  files(treeish: string): Record<string, string> {
    const out = this.git(['ls-tree', '-r', '-z', treeish]);
    const files: Record<string, string> = {};
    for (const entry of out.split('\0').filter(Boolean)) {
      const [info = '', path = ''] = entry.split('\t');
      const [, type, blob] = info.split(' ');
      if (type === 'blob' && blob) files[path] = this.git(['cat-file', 'blob', blob]);
    }
    return files;
  }

  /** Entries of a tree: top level, or every file and folder with `recursive`. */
  treeEntries(tree: string, recursive: boolean): { path: string; type: string; mode: string }[] {
    const out = this.git(['ls-tree', ...(recursive ? ['-r', '-t'] : []), '-z', tree]);
    return out
      .split('\0')
      .filter(Boolean)
      .map((entry) => {
        const [info = '', path = ''] = entry.split('\t');
        const [mode = '', type = ''] = info.split(' ');
        return { path, type, mode };
      });
  }

  /** A new tree: `base` (or nothing) with the given files written, or removed when null. */
  writeTree(base: string | undefined, changes: Record<string, string | null>): string {
    const index = join(this.path, `fake-index-${String(process.pid)}`);
    const env = { GIT_INDEX_FILE: index };
    try {
      if (base) this.git(['read-tree', base], undefined, env);
      else this.git(['read-tree', '--empty'], undefined, env);
      for (const [path, content] of Object.entries(changes)) {
        if (content === null) {
          this.git(['update-index', '--force-remove', '--', path], undefined, env);
        } else {
          const blob = this.git(['hash-object', '-w', '--stdin'], content).trim();
          this.git(
            ['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`],
            undefined,
            env,
          );
        }
      }
      return this.git(['write-tree'], undefined, env).trim();
    } finally {
      rmSync(index, { force: true });
    }
  }

  commitTree(tree: string, parents: string[], message: string): string {
    return this.git(
      ['commit-tree', tree, ...parents.flatMap((parent) => ['-p', parent])],
      message,
    ).trim();
  }

  /** A commit on `branch` (created when missing, from nothing) with the files changed. */
  commitFiles(branch: string, changes: Record<string, string | null>, message: string): string {
    const head = this.branch(branch);
    const tree = this.writeTree(head && this.commit(head)?.tree, changes);
    const sha = this.commitTree(tree, head ? [head] : [], message);
    this.setBranch(branch, sha, head ?? null);
    return sha;
  }

  isAncestor(ancestor: string, sha: string): boolean {
    return this.status(['merge-base', '--is-ancestor', ancestor, sha]).code === 0;
  }

  /** The tree of merging `theirs` into `ours`, or null on a conflict. */
  mergeTree(ours: string, theirs: string): string | null {
    const { code, stdout } = this.status(['merge-tree', '--write-tree', ours, theirs]);
    if (code === 1) return null;
    if (code !== 0) throw new Error(`git merge-tree failed for ${ours} and ${theirs}`);
    return stdout.split('\n')[0] ?? null;
  }

  /** Files that differ between two commits. */
  changedFiles(from: string, to: string): string[] {
    return this.git(['diff', '--name-only', from, to]).split('\n').filter(Boolean);
  }

  /** Commits reachable from `head` and not from `base`, oldest first. */
  commitsBetween(base: string, head: string): string[] {
    return this.git(['rev-list', '--reverse', head, `^${base}`])
      .split('\n')
      .filter(Boolean);
  }
}

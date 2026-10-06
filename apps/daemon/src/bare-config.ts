import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TEXT_CEILING, maskSecrets } from '@orchestrator/protocol';
import type { Git } from './git.js';

// The bare clone's Git configuration and hooks, as the daemon wrote them (05, section 7.1; lot 3
// step D2). An agent can change them, and every worktree of the repository reads them. The
// credentialed commands never read them (isolated repository), so a change is not refused: at
// each run's end the daemon compares them with what it wrote, restores them, and reports what
// changed, naming settings and hook files, never their values. Common tools change them on their
// own (husky sets `core.hooksPath`), so this is information only.

/** The refspec the daemon gives the bare clone's `origin`. */
export const ORIGIN_FETCH = '+refs/heads/*:refs/remotes/origin/*';

/** Settings describing the repository's format: kept as they are, since changing them breaks it. */
const FORMAT_KEYS = new Set([
  'core.repositoryformatversion',
  'extensions.objectformat',
  'extensions.refstorage',
  'extensions.compatobjectformat',
]);

/** Settings `git init` writes for the platform: kept while they hold a boolean. */
const PLATFORM_KEYS = new Set([
  'core.filemode',
  'core.ignorecase',
  'core.precomposeunicode',
  'core.symlinks',
]);

/** One setting as `git config --list -z` gives it; Git lowercases the section and the name. */
interface Entry {
  key: string;
  value: string;
}

/** The settings the daemon writes itself (`workspace.ts`), with their only allowed value. */
function ownedEntries(cloneUrl: string): Entry[] {
  return [
    { key: 'extensions.worktreeconfig', value: 'true' },
    { key: 'remote.origin.url', value: cloneUrl },
    { key: 'remote.origin.fetch', value: ORIGIN_FETCH },
    { key: 'credential.helper', value: '' },
  ];
}

/** The bare clone's own per-worktree configuration (`config.worktree`). */
const MAIN_WORKTREE_ENTRIES: Entry[] = [{ key: 'core.bare', value: 'true' }];

/** Reads a configuration file without following its includes; null when Git cannot read it. */
async function readEntries(git: Git, file: string): Promise<Entry[] | null> {
  const listed = await git.exec(['config', '--file', file, '--no-includes', '--list', '-z']);
  if (listed.code !== 0) return null;
  return listed.stdout
    .split('\0')
    .filter(Boolean)
    .map((item) => {
      const newline = item.indexOf('\n');
      // A setting written without `=` has no value: Git reads it as true.
      return newline < 0
        ? { key: item, value: 'true' }
        : { key: item.slice(0, newline), value: item.slice(newline + 1) };
    });
}

/** `[section "subsection"]` and the name of a setting's key. */
function splitKey(key: string): { section: string; subsection: string | null; name: string } {
  const first = key.indexOf('.');
  const last = key.lastIndexOf('.');
  return {
    section: key.slice(0, first),
    subsection: first === last ? null : key.slice(first + 1, last),
    name: key.slice(last + 1),
  };
}

function quoted(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t')}"`;
}

/** A configuration file holding exactly `entries`, grouped by section in their order. */
function configText(entries: Entry[]): string {
  const sections = new Map<string, string[]>();
  for (const entry of entries) {
    const { section, subsection, name } = splitKey(entry.key);
    const header = subsection === null ? `[${section}]` : `[${section} ${quoted(subsection)}]`;
    const lines = sections.get(header) ?? [];
    lines.push(`\t${name} = ${quoted(entry.value)}`);
    sections.set(header, lines);
  }
  return [...sections].map(([header, lines]) => [header, ...lines].join('\n')).join('\n') + '\n';
}

/** Writes `text` to `file` atomically: a reader sees the old file or the new one. */
async function replaceFile(file: string, text: string): Promise<void> {
  const temporary = `${file}.orchestrator-${randomBytes(6).toString('hex')}`;
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, file);
}

function sameEntries(a: Entry[], b: Entry[]): boolean {
  return (
    a.length === b.length &&
    a.every((entry, index) => {
      const other = b[index];
      return other !== undefined && other.key === entry.key && other.value === entry.value;
    })
  );
}

/** What changed in the shared configuration, by kind, each key named once. */
interface Changes {
  added: Set<string>;
  setBack: Set<string>;
  hooks: Set<string>;
  unreadable: Set<string>;
}

async function restoreShared(git: Git, bare: string, cloneUrl: string, changes: Changes) {
  const file = join(bare, 'config');
  const current = await readEntries(git, file);
  const owned = ownedEntries(cloneUrl);
  const ownedKeys = new Set(owned.map((entry) => entry.key));
  if (current === null) {
    // Unreadable: the format is unknown, so the one Git writes for a new repository is used.
    changes.unreadable.add('config');
    await replaceFile(
      file,
      configText([{ key: 'core.repositoryformatversion', value: '0' }, ...owned]),
    );
    return;
  }
  const kept: Entry[] = [];
  const seen = new Set<string>();
  for (const entry of current) {
    if (FORMAT_KEYS.has(entry.key) && !seen.has(entry.key)) {
      kept.push(entry);
    } else if (PLATFORM_KEYS.has(entry.key) && !seen.has(entry.key)) {
      if (entry.value === 'true' || entry.value === 'false') kept.push(entry);
      else changes.setBack.add(entry.key);
    } else if (FORMAT_KEYS.has(entry.key) || PLATFORM_KEYS.has(entry.key)) {
      // Given twice: the first value is kept.
      changes.setBack.add(entry.key);
    } else if (!ownedKeys.has(entry.key)) {
      changes.added.add(entry.key);
    }
    seen.add(entry.key);
  }
  for (const entry of owned) {
    const values = current.filter((each) => each.key === entry.key);
    if (values.length !== 1 || values[0]?.value !== entry.value) changes.setBack.add(entry.key);
  }
  const expected = [...kept, ...owned];
  const actual = current.filter(
    (entry) =>
      FORMAT_KEYS.has(entry.key) || PLATFORM_KEYS.has(entry.key) || ownedKeys.has(entry.key),
  );
  if (
    changes.added.size > 0 ||
    changes.setBack.size > 0 ||
    !sameEntries(sortEntries(actual), sortEntries(expected))
  ) {
    await replaceFile(file, configText(expected));
  }
}

function sortEntries(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) =>
    (a.key + '\n' + a.value).localeCompare(b.key + '\n' + b.value),
  );
}

async function restoreMainWorktree(git: Git, bare: string, changes: Changes) {
  const file = join(bare, 'config.worktree');
  const current = await readEntries(git, file);
  if (current === null) {
    changes.unreadable.add('config.worktree');
  } else {
    for (const entry of current) {
      if (entry.key !== 'core.bare') changes.added.add(`${entry.key} (config.worktree)`);
    }
    if (sameEntries(current, MAIN_WORKTREE_ENTRIES)) return;
    if (!current.some((entry) => entry.key !== 'core.bare')) {
      changes.setBack.add('core.bare (config.worktree)');
    }
  }
  await replaceFile(file, configText(MAIN_WORKTREE_ENTRIES));
}

/**
 * Hooks: `git init` writes inert `*.sample` files only. Anything else in `hooks/` was added after
 * and is removed; a `hooks` that is not a folder is replaced by an empty one.
 */
async function restoreHooks(bare: string, changes: Changes) {
  const folder = join(bare, 'hooks');
  const info = await lstat(folder).catch(() => null);
  if (info === null) return;
  if (!info.isDirectory()) {
    changes.hooks.add('hooks (not a folder)');
    await rm(folder, { recursive: true, force: true });
    await mkdir(folder, { mode: 0o755 });
    return;
  }
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.sample')) continue;
    changes.hooks.add(entry.name);
    await rm(join(folder, entry.name), { recursive: true, force: true });
  }
}

/** A name for the event: credentials in a URL subsection are masked, and it is kept short. */
function shown(name: string): string {
  return maskSecrets(name.replace(/\/\/[^/@\s]*@/g, '//***@')).slice(0, 200);
}

function list(names: Set<string>): string {
  return [...names].sort().map(shown).join(', ');
}

/**
 * Compares the bare clone's configuration (`config`, `config.worktree`) and hooks with what the
 * daemon wrote, restores them, and says what changed in plain words; null when nothing did. The
 * caller holds the bare clone's lock. The per-worktree configuration of other runs' worktrees
 * (their commit author) is left as it is.
 */
export async function restoreBareConfig(
  git: Git,
  bare: string,
  cloneUrl: string,
): Promise<string | null> {
  const changes: Changes = {
    added: new Set(),
    setBack: new Set(),
    hooks: new Set(),
    unreadable: new Set(),
  };
  await restoreShared(git, bare, cloneUrl, changes);
  await restoreMainWorktree(git, bare, changes);
  await restoreHooks(bare, changes);
  const parts: string[] = [];
  if (changes.added.size > 0)
    parts.push(`Settings added during the run, removed: ${list(changes.added)}.`);
  if (changes.setBack.size > 0) parts.push(`Settings changed, set back: ${list(changes.setBack)}.`);
  if (changes.hooks.size > 0) parts.push(`Hook files added, removed: ${list(changes.hooks)}.`);
  if (changes.unreadable.size > 0) {
    parts.push(`Files Git could not read, written again: ${list(changes.unreadable)}.`);
  }
  return parts.length === 0 ? null : parts.join(' ').slice(0, TEXT_CEILING);
}

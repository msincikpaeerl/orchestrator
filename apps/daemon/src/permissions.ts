import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

// Permission enforcement for a run (05, section 4.6), in two layers: the allowlist and deny rules
// of the run's `settings.json`, and the `PreToolUse` rules below, which the hook applies to every
// tool call. File tools are checked exactly; Bash commands are checked on their text, which is
// best effort: a program can open files in ways no command text shows.

/** Where a run may work, and the folders it must never reach. */
export interface PermissionScope {
  /** The run's worktree: the only folder file tools may reach. */
  worktree: string;
  /** The daemon's folder, `~/.orchestrator` (machine token, Claude configuration, other runs). */
  daemonHome: string;
  /** The owner's home folder, which holds `~/.claude` and `~/.claude.json`. */
  userHome: string;
  /** The system temporary folders a Bash command may name: `/tmp` and `$TMPDIR`. */
  tempDirs: readonly string[];
}

/** Always allowed: Claude Code loads MCP tools with it (03, section 6). */
export const TOOL_SEARCH = 'ToolSearch';
/** Every tool of the Orchestrator's MCP server; the server enforces each role's permissions. */
export const ORCHESTRATOR_MCP = 'mcp__orchestrator';

/** Entries of the daemon's folder closed by settings deny rules; `worktrees/` stays open. */
const DAEMON_FILES = ['config.json', 'daemon.sock', 'last-stop.json'];
const DAEMON_FOLDERS = ['claude-config', 'repos', 'runs'];

/** A rule path for an absolute path: Claude Code writes absolute paths with `//`. */
const rulePath = (path: string) => `/${path}`;

/**
 * The `permissions` of a run's `settings.json` (05, section 4.6): the profile's allowlist with
 * `ToolSearch` and the Orchestrator's MCP tools, and deny rules for the daemon's folder (but its
 * worktrees) and the Claude configuration folders.
 */
export function settingsPermissions(
  scope: Pick<PermissionScope, 'daemonHome' | 'userHome'>,
  allowedTools: readonly string[],
): { allow: string[]; deny: string[] } {
  const allow = [...new Set([...allowedTools, TOOL_SEARCH, ORCHESTRATOR_MCP])];
  const targets = [
    ...DAEMON_FILES.map((name) => join(scope.daemonHome, name)),
    ...DAEMON_FOLDERS.map((name) => `${join(scope.daemonHome, name)}/**`),
    `${join(scope.userHome, '.claude')}/**`,
    join(scope.userHome, '.claude.json'),
  ];
  const deny = targets.flatMap((target) => [
    `Read(${rulePath(target)})`,
    `Edit(${rulePath(target)})`,
  ]);
  return { allow, deny };
}

// Reasons the agent reads. They say what to do instead (06, section 6).

const ASK = 'If you need it for your ticket, explain why with ticket_ask.';

export const REASONS = {
  remote: `Git commands that reach a remote, and gh or hub, are refused: the Orchestrator fetches and pushes the branch itself. Commit your work locally. ${ASK}`,
  github: `Commands that reach GitHub are refused: the Orchestrator talks to GitHub itself. ${ASK}`,
  tmux: 'tmux commands are refused: the Orchestrator runs your session in tmux and must be the only one driving it.',
  claudeFolder: `Changes to the repository's .claude folder are refused (and Bash commands naming it): it configures Claude Code for the owner. ${ASK}`,
  daemonFolder:
    "Access to the Orchestrator's own folder is refused: it holds the machine's key and other runs' work.",
  claudeConfig: "Access to Claude Code's configuration folders is refused: they hold its login.",
  outside: `Access outside your worktree is refused. Work with paths inside the worktree (relative paths are best). ${ASK}`,
  bashPath: `This command names a path outside your worktree, which is refused. Use paths inside the worktree (relative paths are best); /tmp, /dev/null and system folders such as /usr and /etc are allowed. If the text is not a path (a URL path in a grep pattern, for example), write it without its leading "/". ${ASK}`,
  home: `This command names the home folder (~ or $HOME), which is refused. Use paths inside your worktree. ${ASK}`,
} as const;

// Paths.

function inside(path: string, folder: string): boolean {
  const rel = relative(folder, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The real path of `path`, resolving symbolic links of its nearest existing ancestor. */
function realPath(path: string): string {
  const missing: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(realpathSync(current), ...missing.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      missing.push(basename(current));
      current = parent;
    }
  }
}

/** Why a path is refused, or null when it is inside the worktree. */
function fileRefusal(scope: PermissionScope, path: string): string | null {
  const absolute = realPath(resolve(scope.worktree, path));
  if (inside(absolute, realPath(scope.worktree))) return null;
  return protectedRefusal(scope, absolute) ?? REASONS.outside;
}

/** The reason for a path in the daemon's folder or a Claude configuration folder. */
function protectedRefusal(scope: PermissionScope, absolute: string): string | null {
  const claudeConfigs = [
    join(scope.daemonHome, 'claude-config'),
    join(scope.userHome, '.claude'),
    join(scope.userHome, '.claude.json'),
  ].map(realPath);
  if (claudeConfigs.some((folder) => inside(absolute, folder))) return REASONS.claudeConfig;
  if (inside(absolute, realPath(scope.daemonHome))) return REASONS.daemonFolder;
  return null;
}

/** Input fields holding a path, for each file tool (Claude Code's tools reference). */
const FILE_TOOLS: Record<string, { fields: string[]; writes: boolean }> = {
  Read: { fields: ['file_path'], writes: false },
  Write: { fields: ['file_path'], writes: true },
  Edit: { fields: ['file_path'], writes: true },
  MultiEdit: { fields: ['file_path'], writes: true },
  NotebookEdit: { fields: ['notebook_path'], writes: true },
  NotebookRead: { fields: ['notebook_path'], writes: false },
  Glob: { fields: ['path', 'pattern'], writes: false },
  Grep: { fields: ['path', 'glob'], writes: false },
  LS: { fields: ['path'], writes: false },
};

function checkFileTool(
  scope: PermissionScope,
  tool: { fields: string[]; writes: boolean },
  input: Record<string, unknown>,
): string | null {
  for (const field of tool.fields) {
    const value = input[field];
    if (typeof value !== 'string' || value === '') continue;
    // Patterns (`**/*.ts`) are relative to the worktree; only a rooted one names a place.
    const pattern = field === 'pattern' || field === 'glob';
    if (pattern && !value.startsWith('/') && !value.startsWith('~') && !value.includes('..')) {
      continue;
    }
    if (value.startsWith('~')) return REASONS.outside;
    const refusal = fileRefusal(scope, pattern ? value.replace(/[*?[{].*$/, '') || '/' : value);
    if (refusal) return refusal;
    if (tool.writes) {
      const rel = relative(realPath(scope.worktree), realPath(resolve(scope.worktree, value)));
      if (rel.split(sep).includes('.claude')) return REASONS.claudeFolder;
    }
  }
  return null;
}

// Bash commands (best effort).

/** Separators of simple commands and substitutions: `;`, `&&`, `||`, `|`, `&`, newlines, `$(`, backticks, parentheses. */
const COMMAND_SEPARATORS = /\|\||&&|[;|&\n`()]|\$\(/;
/** Words that run the command after them. */
const WRAPPERS = new Set([
  'env',
  'command',
  'exec',
  'nohup',
  'time',
  'sudo',
  'xargs',
  'nice',
  'timeout',
  'builtin',
  'eval',
  'then',
  'do',
  'else',
  '!',
]);
/** Git options taking a value as the next word. */
const GIT_OPTIONS_WITH_VALUE = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--config-env',
]);
/** Git subcommands that talk to a remote. */
const GIT_REMOTE_COMMANDS = new Set([
  'push',
  'fetch',
  'pull',
  'clone',
  'ls-remote',
  'send-pack',
  'fetch-pack',
  'submodule',
]);
/** `git remote` subcommands that change a remote or talk to it. */
const GIT_REMOTE_SUBCOMMANDS = new Set(['add', 'set-url', 'update', 'prune', 'show']);

/** The words of a simple command, quotes removed (best effort, no expansion). */
function words(command: string): string[] {
  const result: string[] = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let word = '';
  let last = -1;
  for (const match of command.matchAll(pattern)) {
    const text = match[1] ?? match[2] ?? match[3] ?? '';
    // Parts written next to each other (`a"b"`) are one word.
    if (match.index === last) word += text;
    else {
      if (last >= 0) result.push(word);
      word = text;
    }
    last = match.index + match[0].length;
  }
  if (last >= 0) result.push(word);
  return result;
}

/** The program and its arguments, after variable assignments and wrappers such as `env`. */
function program(parts: string[]): string[] {
  let index = 0;
  while (index < parts.length) {
    const part = parts[index] ?? '';
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(part) || WRAPPERS.has(basename(part))) index++;
    // Options and durations of a wrapper (`env -i`, `timeout 10`).
    else if (index > 0 && (part.startsWith('-') || /^\d+(\.\d+)?[smhd]?$/.test(part))) index++;
    else break;
  }
  return parts.slice(index);
}

function gitRefusal(args: string[]): string | null {
  let index = 0;
  while (index < args.length) {
    const arg = args[index] ?? '';
    if (GIT_OPTIONS_WITH_VALUE.has(arg)) index += 2;
    else if (arg.startsWith('-')) index++;
    else break;
  }
  const subcommand = args[index];
  if (subcommand === undefined) return null;
  if (GIT_REMOTE_COMMANDS.has(subcommand)) return REASONS.remote;
  if (subcommand === 'remote' && GIT_REMOTE_SUBCOMMANDS.has(args[index + 1] ?? '')) {
    return REASONS.remote;
  }
  return null;
}

/** Folders outside the worktree a Bash command may name (05, section 4.6). */
const SYSTEM_FOLDERS = ['/usr', '/bin', '/sbin', '/etc', '/opt', '/proc/self'];
const DEVICES = ['/dev/null', '/dev/stdin', '/dev/stdout', '/dev/stderr'];

function allowedSystemPath(scope: PermissionScope, path: string): boolean {
  if (DEVICES.includes(path)) return true;
  if (/^\/lib[^/]*(\/|$)/.test(path)) return true;
  return [...SYSTEM_FOLDERS, ...scope.tempDirs].some((folder) => inside(path, folder));
}

/** Candidate paths in a word: itself, the value of `--option=value`, redirections, `a:b` lists. */
function pathCandidates(word: string): string[] {
  const stripped = word.replace(/^\d*[<>]+&?/, '');
  const value = stripped.includes('=') ? stripped.slice(stripped.indexOf('=') + 1) : '';
  return [stripped, value]
    .flatMap((each) => (/^[a-z][a-z0-9+.-]*:\/\//i.test(each) ? [] : each.split(':')))
    .filter(Boolean);
}

function pathRefusal(scope: PermissionScope, word: string): string | null {
  if (/\$\{?HOME\b/.test(word)) return REASONS.home;
  for (const candidate of pathCandidates(word)) {
    if (candidate.startsWith('~')) return REASONS.home;
    const absolute = candidate.startsWith('/');
    if (!absolute && !candidate.split('/').includes('..')) continue;
    const path = resolve(scope.worktree, candidate);
    if (inside(path, scope.worktree)) continue;
    const refusal = protectedRefusal(scope, path);
    if (refusal) return refusal;
    if (inside(path, scope.userHome)) return REASONS.bashPath;
    if (!allowedSystemPath(scope, path)) return REASONS.bashPath;
  }
  return null;
}

export function checkBash(scope: PermissionScope, command: string): string | null {
  if (/(?<![\w-])tmux(?![\w-])/.test(command)) return REASONS.tmux;
  if (/(?<![\w.-])\.claude(?![\w-])/.test(command)) {
    // `~/.claude` and `~/.claude.json` are the owner's configuration: the more precise reason.
    return /(~|\$\{?HOME\}?)\/\.claude/.test(command) ? REASONS.claudeConfig : REASONS.claudeFolder;
  }
  if (/github\.com|githubusercontent\.com/i.test(command)) return REASONS.github;
  for (const segment of command.split(COMMAND_SEPARATORS)) {
    const parts = words(segment);
    const [name, ...args] = program(parts);
    if (name !== undefined) {
      const base = basename(name);
      if (base === 'gh' || base === 'hub') return REASONS.remote;
      if (base === 'git') {
        const refusal = gitRefusal(args);
        if (refusal) return refusal;
      }
    }
    for (const word of parts) {
      const refusal = pathRefusal(scope, word);
      if (refusal) return refusal;
    }
  }
  return null;
}

/**
 * Why the `PreToolUse` hook refuses a tool call (05, section 4.6), or null to let Claude Code's
 * own permission rules decide.
 */
export function checkToolCall(scope: PermissionScope, tool: string, input: unknown): string | null {
  const fields =
    typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  if (tool === 'Bash') {
    return typeof fields.command === 'string' ? checkBash(scope, fields.command) : null;
  }
  const fileTool = FILE_TOOLS[tool];
  return fileTool ? checkFileTool(scope, fileTool, fields) : null;
}

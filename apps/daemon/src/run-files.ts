import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DaemonRunState,
  GitHash,
  HookEvent,
  RunEndReason,
  RunStart,
  StatusLineInput,
  type RunLimits,
} from '@orchestrator/protocol';
import { z } from 'zod';
import { safeJson } from './config.js';
import type { DaemonPaths } from './paths.js';
import { settingsPermissions } from './permissions.js';
import { runFolder, runSocketPath } from './run-socket.js';
import { shellCommand } from './self.js';

// A run's files (05, section 4.2), in `runs/<run-id>/`, never inside the worktree.

/** Writes JSON through a temporary file and a rename, readable by the owner only. */
export function writeJsonAtomic(path: string, value: unknown): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

export function readJson(path: string): unknown {
  try {
    return safeJson(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** `state.json`: what a restarted daemon needs to find the run again (05, section 6). */
export const RunStateFile = z.object({
  start: RunStart.shape.payload,
  state: DaemonRunState,
  endReason: RunEndReason.nullable(),
  claudeSessionId: z.string().nullable(),
  transcriptPath: z.string().nullable(),
  transcriptOffset: z.int().min(0),
  /** Transcript lines skipped so far (05, section 4.5). */
  skippedLines: z.int().min(0),
  /** Position of the next log entry. */
  nextSeq: z.int().min(0),
  nudgesSent: z.int().min(0),
  /** Working time so far (05, section 5). */
  workingMs: z.number().min(0),
  /** Messages waiting for the session to be idle (05, section 4.4). */
  pendingInputs: z.array(z.string()),
  bare: z.string().nullable(),
  worktree: z.string().nullable(),
  // Defaults: a state.json written by daemon 0.2.0 has none of the fields below.
  /**
   * An accepted decision tool of the current turn, applied when the turn ends (05, section 4.8);
   * `push_failed` when the push at a `ticket_submit` failed, whatever the server answered, kept
   * over any later decision of the turn (04, section 3.1; lot 3 step F); `waiting_ci` when the
   * server answered `pending_ci` (05, section 4.9; lot 3 step G1a).
   */
  decision: z
    .enum(['submitted', 'gave_up', 'asked', 'push_failed', 'waiting_ci'])
    .nullable()
    .default(null),
  /** A `PreToolUse` came during the current turn (05, section 4.10). */
  turnToolUsed: z.boolean().default(false),
  /** When the run started waiting for the owner (epoch ms): the waiting run lifetime's clock. */
  waitingSince: z.number().nullable().default(null),
  /** The latest status line input (05, section 4.5). */
  statusLine: StatusLineInput.nullable().default(null),
  /** The transcript facts of `TranscriptReader`, kept across a daemon restart. */
  transcriptApiError: z.string().nullable().default(null),
  transcriptCostUsd: z.number().nullable().default(null),
  /** A review run's heads at the start, compared at its end (05, section 4.2; lot 3 step D2). */
  reviewStart: z
    .object({ head: GitHash, localBranch: GitHash.nullable() })
    .nullable()
    .default(null),
  /**
   * Ids of the latest `run.input` and `run.resume` given to the session, written with the queued
   * text: a copy of one after a daemon restart is acknowledged without being given again, so a CI
   * round reaches the agent once (lot 3 step G2b). The newest `DELIVERED_IDS_KEPT`.
   */
  deliveredIds: z.array(z.string()).default([]),
  /**
   * Whether Claude Code took the launch's message (`UserPromptSubmit`, 05, section 4.2.1; lot 5
   * step 5bis E). A state.json written before has none: taken, so a run in flight never fails.
   */
  messageTaken: z.boolean().default(true),
});
export type RunStateFile = z.infer<typeof RunStateFile>;

/** How many delivered message ids a run keeps: far more than the server ever sends again. */
export const DELIVERED_IDS_KEPT = 50;

export function stateFilePath(paths: DaemonPaths, runId: string): string {
  return join(runFolder(paths, runId), 'state.json');
}

export function createRunFolder(paths: DaemonPaths, runId: string): string {
  const folder = runFolder(paths, runId);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  chmodSync(folder, 0o700);
  return folder;
}

/**
 * The run's settings (05, sections 4.5 and 4.6): the hooks, each reporting to the run's socket,
 * the status line command, the allowlist and deny rules, and no automatic continue.
 */
export function runSettings(
  paths: Pick<DaemonPaths, 'home' | 'userHome'>,
  start: Pick<RunStart['payload'], 'runId' | 'profile'>,
  selfCommand: readonly string[],
) {
  const command = (...args: string[]) =>
    shellCommand([...selfCommand, ...args, '--run', start.runId]);
  return {
    permissions: settingsPermissions(
      { daemonHome: paths.home, userHome: paths.userHome },
      start.profile.allowedTools,
    ),
    hooks: Object.fromEntries(
      HookEvent.options.map((event) => [
        event,
        [{ hooks: [{ type: 'command', command: command('hook', event) }] }],
      ]),
    ),
    statusLine: { type: 'command', command: command('status-line') },
    ...NO_AUTOMATIC_CONTINUE,
  };
}

/**
 * Only the Orchestrator decides when a paused run continues (05, section 4.10). Claude Code's
 * documentation gives this key the scope "User or managed", so it goes both in the run's
 * `--settings` and in the user settings of the dedicated configuration (05, section 4.3).
 */
export const NO_AUTOMATIC_CONTINUE = { autoContinueAtUsageLimit: false } as const;

/**
 * Sets the daemon's keys in `settings.json` of the dedicated configuration folder, the only user
 * settings a run reads (`--setting-sources user`), keeping any other key found there.
 */
export function writeUserSettings(claudeConfig: string): string {
  mkdirSync(claudeConfig, { recursive: true, mode: 0o700 });
  const file = join(claudeConfig, 'settings.json');
  const found = readJson(file);
  const current = found !== null && typeof found === 'object' && !Array.isArray(found) ? found : {};
  writeJsonAtomic(file, { ...current, ...NO_AUTOMATIC_CONTINUE });
  return file;
}

/** What `claudeArguments` needs for one launch. */
export interface LaunchInput {
  mcpConfig: string;
  settings: string;
  model: string;
  instructions: string;
  resumeSessionId: string | null;
  message: string;
}

/** The arguments of a launch, in the order of 05 section 4.3 (after the `claude` executable). */
export function claudeArguments(launch: LaunchInput): string[] {
  return [
    '--mcp-config',
    launch.mcpConfig,
    '--strict-mcp-config',
    '--setting-sources',
    'user',
    '--settings',
    launch.settings,
    '--permission-mode',
    'dontAsk',
    '--model',
    launch.model,
    '--append-system-prompt',
    launch.instructions,
    ...(launch.resumeSessionId ? ['--resume', launch.resumeSessionId] : []),
    '--',
    launch.message,
  ];
}

/**
 * The launcher of 05 section 4.3 (lot 5 step 5bis C): a fixed script that reads the instructions
 * (`$2`) and the message (`$3`) from the run's files with `cat` (`$1`, an absolute path: the
 * session's `PATH` is the daemon's), then replaces itself with Claude Code (the rest of its
 * arguments), giving it `claudeArguments`'s list exactly: `--append-system-prompt`, `--resume`
 * when `$4` is a session id, `--` and the message. The texts never reach tmux's command, which its
 * client caps at about 16 KB, and the shell never interprets them: they are expanded within double
 * quotes only. `printf x` then `${i%x}` keeps their trailing newlines, which a command
 * substitution alone removes. A text that cannot be read, or reads as empty, starts no Claude
 * Code: the script writes why in `$5` and exits with an error, which the daemon reports as
 * `launch_failed` (lot 5 step 5bis D). The check comes after `${i%x}`, so a launcher whose `${…}`
 * something emptied on the way (systemd-run's expansion) fails too.
 */
export const LAUNCH_SCRIPT = [
  'c=$1 e=$5',
  'i=$("$c" -- "$2" && printf x) || { printf \'%s could not be read\\n\' "$2" > "$e"; exit 1; }',
  'm=$("$c" -- "$3" && printf x) || { printf \'%s could not be read\\n\' "$3" > "$e"; exit 1; }',
  'i=${i%x} m=${m%x}',
  '[ -n "$i" ] || { printf \'the instructions (%s) read as empty\\n\' "$2" > "$e"; exit 1; }',
  '[ -n "$m" ] || { printf \'the message (%s) reads as empty\\n\' "$3" > "$e"; exit 1; }',
  'r=$4',
  'shift 5',
  'if [ -n "$r" ]; then exec "$@" --append-system-prompt "$i" --resume "$r" -- "$m"; fi',
  'exec "$@" --append-system-prompt "$i" -- "$m"',
].join('\n');

/** The files of one launch's texts, written by `writeRunFiles`, and the launcher's error file. */
export interface LaunchTexts {
  instructions: string;
  message: string;
  error: string;
}

/**
 * The command starting Claude Code through `LAUNCH_SCRIPT` with `tools.shell` and `tools.cat`: the
 * same arguments as `claudeArguments`, the instructions and the message read from `texts`. Its
 * size depends on the paths and the model only, never on the run's texts.
 */
export function launchCommand(
  tools: { shell: string; cat: string },
  claude: string,
  launch: Omit<LaunchInput, 'instructions' | 'message'> & { texts: LaunchTexts },
): string[] {
  const options = claudeArguments({ ...launch, instructions: '', message: '' });
  const fixed = options.slice(0, options.indexOf('--append-system-prompt'));
  return [
    tools.shell,
    '-c',
    LAUNCH_SCRIPT,
    'orchestrator-launch',
    tools.cat,
    launch.texts.instructions,
    launch.texts.message,
    launch.resumeSessionId ?? '',
    launch.texts.error,
    claude,
    ...fixed,
  ];
}

/** The MCP relay of the run (06, section 1), with Claude Code's tool timeout (04, section 8). */
export function runMcpConfig(runId: string, selfCommand: readonly string[], limits: RunLimits) {
  const [command = '', ...args] = selfCommand;
  return {
    mcpServers: {
      orchestrator: {
        type: 'stdio',
        command,
        args: [...args, 'mcp', '--run', runId],
        timeout: limits.claudeCodeMcpToolTimeoutSeconds * 1000,
      },
    },
  };
}

export interface RunFiles {
  settings: string;
  mcpConfig: string;
  socket: string;
  texts: LaunchTexts;
}

/** Writes `text` readable by the owner only, as it is, through a temporary file and a rename. */
function writeTextAtomic(path: string, text: string): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

/**
 * Writes `system-prompt.md` (the instructions), `message.md` (this launch's message: the first
 * message, or the one after `--resume`), `settings.json` and `mcp.json` for a launch, and the
 * daemon's keys in the dedicated configuration's user settings.
 */
export function writeRunFiles(
  paths: DaemonPaths,
  start: RunStart['payload'],
  selfCommand: readonly string[],
  message: string,
): RunFiles {
  const folder = createRunFolder(paths, start.runId);
  const settings = join(folder, 'settings.json');
  const mcpConfig = join(folder, 'mcp.json');
  const texts = {
    instructions: join(folder, 'system-prompt.md'),
    message: join(folder, 'message.md'),
    error: join(folder, 'launch-error'),
  };
  rmSync(texts.error, { force: true });
  writeTextAtomic(texts.instructions, start.profile.instructions);
  writeTextAtomic(texts.message, message);
  writeJsonAtomic(settings, runSettings(paths, start, selfCommand));
  writeJsonAtomic(mcpConfig, runMcpConfig(start.runId, selfCommand, start.limits));
  writeUserSettings(paths.claudeConfig);
  return { settings, mcpConfig, socket: runSocketPath(paths, start.runId), texts };
}

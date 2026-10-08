import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
   * over any later decision of the turn (04, section 3.1; lot 3 step F).
   */
  decision: z.enum(['submitted', 'gave_up', 'asked', 'push_failed']).nullable().default(null),
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
});
export type RunStateFile = z.infer<typeof RunStateFile>;

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
}

/**
 * Writes `system-prompt.md`, `settings.json` and `mcp.json` for a launch, and the daemon's keys in
 * the dedicated configuration's user settings.
 */
export function writeRunFiles(
  paths: DaemonPaths,
  start: RunStart['payload'],
  selfCommand: readonly string[],
): RunFiles {
  const folder = createRunFolder(paths, start.runId);
  const settings = join(folder, 'settings.json');
  const mcpConfig = join(folder, 'mcp.json');
  writeFileSync(join(folder, 'system-prompt.md'), start.profile.instructions, { mode: 0o600 });
  writeJsonAtomic(settings, runSettings(paths, start, selfCommand));
  writeJsonAtomic(mcpConfig, runMcpConfig(start.runId, selfCommand, start.limits));
  writeUserSettings(paths.claudeConfig);
  return { settings, mcpConfig, socket: runSocketPath(paths, start.runId) };
}

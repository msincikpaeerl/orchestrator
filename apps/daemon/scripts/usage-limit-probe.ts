import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { SETTINGS, StatusLineInput } from '@orchestrator/protocol';
import { login } from '../src/login.js';
import { daemonPaths } from '../src/paths.js';
import {
  claudeArguments,
  readJson,
  runMcpConfig,
  runSettings,
  writeJsonAtomic,
  writeUserSettings,
} from '../src/run-files.js';
import { shellCommand } from '../src/self.js';
import { TrustRegistry } from '../src/trust.js';
import {
  API_ERROR_PATTERNS,
  USAGE_LIMIT_PATTERNS,
  assessTurn,
  type TurnEnd,
} from '../src/usage-limit.js';
import {
  credentialLikeFound,
  keptTranscript,
  personalDataFound,
  sanitise,
  sessionPersonalValues,
  type PersonalValue,
} from './claude-code-probe-fixtures.js';

// The helper of the usage-limit capture (05, section 4.10; lot 2 plan, step M), called by
// `tools/spike/claude-code-spike.sh --probe-limit` and `--scan-limit` only. Like the Claude Code
// probe of step H, it builds the session from the daemon's own code (settings with every hook,
// the status line and `autoContinueAtUsageLimit: false`, the argument list, the login, the trust),
// with the probe's recorder instead of the daemon's commands.
//
//   prepare  --scratch <folder>                  the layout and a one-file repository
//   login    --scratch <folder>                  `orchestrator-daemon login` on the capture's folder
//   session  --scratch <folder> --model <model>  the session's files; prints its arguments, NUL-separated
//   evaluate --scratch <folder> --version <v> --model <model> --fixtures <folder>
//                                                prints what was recorded and what the daemon's
//                                                detection makes of it; writes the fixtures only
//                                                when a limit was seen
//   scan     [--days <n>]                        prints the transcript lines holding an API error
//                                                or a known usage-limit message (no session)
//
// It never tries to reach the limit: the owner runs it while Claude Code already shows one, and
// the one message is refused at no cost (or, the limit being over, answered in a few tokens).

const MESSAGE = 'Reply with the word OK.';
const SESSION = 'limit';

/** Hooks recorded besides the daemon's own: the message arriving. */
const EXTRA_HOOKS = ['UserPromptSubmit'];

/** Words of Claude Code's own automatic continue, which `autoContinueAtUsageLimit: false` turns off. */
const AUTO_CONTINUE =
  /continu\w* automatically|auto[- ]?continu|will (?:resume|continue) (?:at|when)/i;
/** Screen lines worth showing: the limit, its reset, a continue. */
const SCREEN_LINE = /limit|resets?\b|continu|api error|rate/i;

const repository = resolve(import.meta.dirname, '..', '..', '..');
const recorderScript = join(import.meta.dirname, 'claude-code-probe-recorder.ts');
const tsxCli = createRequire(join(import.meta.dirname, '..', 'package.json')).resolve('tsx/cli');

interface Layout {
  scratch: string;
  userHome: string;
  daemonHome: string;
  claudeConfig: string;
  record: string;
  bare: string;
  worktree: string;
}

function layoutOf(scratch: string): Layout {
  const userHome = join(scratch, 'home');
  const paths = daemonPaths({
    ORCHESTRATOR_HOME: join(userHome, '.orchestrator'),
    HOME: userHome,
    XDG_CONFIG_HOME: join(userHome, '.config'),
  });
  return {
    scratch,
    userHome,
    daemonHome: paths.home,
    claudeConfig: paths.claudeConfig,
    record: join(scratch, 'record'),
    bare: join(paths.home, 'repos', 'limit', 'limit.git'),
    worktree: join(paths.home, 'worktrees', SESSION),
  };
}

const recorderCommand = (layout: Layout) => [
  process.execPath,
  tsxCli,
  recorderScript,
  '--log',
  layout.record,
];

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=Limit probe', '-c', 'user.email=probe@localhost', ...args],
    {
      cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );

function prepare(layout: Layout): void {
  mkdirSync(layout.record, { recursive: true });
  mkdirSync(layout.daemonHome, { recursive: true, mode: 0o700 });
  const source = join(layout.scratch, 'source');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'README.md'), '# Usage-limit capture\n');
  git(source, 'init', '-q', '-b', 'main');
  git(source, 'add', '-A');
  git(source, 'commit', '-qm', 'Usage-limit capture');
  mkdirSync(dirname(layout.bare), { recursive: true });
  git(layout.scratch, 'clone', '-q', '--bare', source, layout.bare);
  git(layout.bare, 'worktree', 'add', '-q', '-b', 'probe/limit', layout.worktree, 'main');
}

/** The session's files, from the daemon's generation; returns its arguments. */
function session(layout: Layout, model: string): string[] {
  const folder = join(layout.daemonHome, 'runs', SESSION);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const selfCommand = recorderCommand(layout);
  const settings = runSettings(
    { home: layout.daemonHome, userHome: layout.userHome },
    {
      runId: SESSION,
      profile: { key: 'web_dev', version: 1, instructions: '', model, allowedTools: [] },
    },
    selfCommand,
  );
  const hooks = {
    ...settings.hooks,
    ...Object.fromEntries(
      EXTRA_HOOKS.map((event) => [
        event,
        [
          {
            hooks: [
              {
                type: 'command',
                command: shellCommand([...selfCommand, 'hook', event, '--run', SESSION]),
              },
            ],
          },
        ],
      ]),
    ),
  };
  const settingsFile = join(folder, 'settings.json');
  const mcpConfig = join(folder, 'mcp.json');
  writeJsonAtomic(settingsFile, { ...settings, hooks });
  writeJsonAtomic(
    mcpConfig,
    runMcpConfig(SESSION, selfCommand, {
      claudeCodeMcpToolTimeoutSeconds: SETTINGS.claudeCodeMcpToolTimeoutSeconds.default,
      pushTimeoutSeconds: SETTINGS.pushTimeoutSeconds.default,
    } as Parameters<typeof runMcpConfig>[2]),
  );
  writeUserSettings(layout.claudeConfig);
  return claudeArguments({
    mcpConfig,
    settings: settingsFile,
    model,
    instructions: 'You are taking part in an automated check. Reply with the single word OK.',
    resumeSessionId: null,
    message: MESSAGE,
  });
}

// Evaluation.

const text = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8') : '');

function jsonLines(value: string): Record<string, unknown>[] {
  return value
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

const field = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** The entry's own text: an assistant or system message, never a tool result or a user message. */
function entryText(entry: Record<string, unknown>): string | null {
  if (entry.type !== 'assistant' && entry.type !== 'system') return null;
  const message = entry.message as { content?: unknown } | undefined;
  const content = message?.content ?? entry.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts = (content as { type?: unknown; text?: unknown }[])
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string);
  return parts.length > 0 ? parts.join('\n') : null;
}

/** A pattern of the daemon's table, matching only at the start of a text. */
const anchored = (pattern: RegExp) =>
  new RegExp(`^\\s*(?:${pattern.source.replace(/^\^\\s\*/, '')})`, pattern.flags);
const SIGNAL_STARTS = [...USAGE_LIMIT_PATTERNS, ...API_ERROR_PATTERNS].map(anchored);

/**
 * A known usage-limit message or API error text as Claude Code shows it, the whole text: a
 * message merely quoting one (in a conversation about this project, for example) does not count.
 */
const startsWithSignal = (value: string | null) =>
  value !== null && SIGNAL_STARTS.some((pattern) => pattern.test(value));

/** A transcript entry the capture and the scan care about: an API error or a limit message. */
function isSignalEntry(entry: Record<string, unknown>): boolean {
  return entry.isApiErrorMessage === true || startsWithSignal(entryText(entry));
}

const cut = (value: string, length = 300) =>
  value.length > length ? `${value.slice(0, length)}…` : value;

interface Evaluation {
  report: string[];
  limitSeen: boolean;
  transcriptPath: string | null;
}

function evaluate(layout: Layout, now: Date): Evaluation {
  const hooksText = text(join(layout.record, `hooks-${SESSION}.jsonl`));
  const hooks = jsonLines(hooksText) as { event?: string; input?: Record<string, unknown> }[];
  const start = hooks.find((hook) => hook.event === 'SessionStart');
  const transcriptPath = field(start?.input?.transcript_path);
  const transcript = transcriptPath ? jsonLines(text(transcriptPath)) : [];
  const statusLines = jsonLines(text(join(layout.record, `status-line-${SESSION}.jsonl`)))
    .map((entry) => StatusLineInput.safeParse(entry.input))
    .flatMap((parsed) => (parsed.success ? [parsed.data] : []));
  const screen = text(join(layout.scratch, `pane-${SESSION}.txt`));

  const counts = new Map<string, number>();
  for (const hook of hooks) counts.set(hook.event ?? '?', (counts.get(hook.event ?? '?') ?? 0) + 1);
  const failure = hooks.find((hook) => hook.event === 'StopFailure');
  const stop = hooks.find((hook) => hook.event === 'Stop');
  const end: TurnEnd = failure
    ? {
        kind: 'stop_failure',
        error: field(failure.input?.error),
        message: field(failure.input?.last_assistant_message),
      }
    : stop
      ? { kind: 'stop', message: field(stop.input?.last_assistant_message) }
      : { kind: 'idle_timeout' };
  const signals = transcript.filter(isSignalEntry);
  const lastAssistant = transcript.filter((entry) => entry.type === 'assistant').at(-1);
  const transcriptApiError =
    lastAssistant?.isApiErrorMessage === true ? (entryText(lastAssistant) ?? '') : null;
  const assessment = assessTurn({
    end,
    toolUsed: counts.has('PreToolUse'),
    transcriptApiError,
    statusLine: statusLines.at(-1) ?? null,
    now,
  });
  const screenLines = screen
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && SCREEN_LINE.test(line));
  const limitSeen =
    end.kind === 'stop_failure' ||
    signals.length > 0 ||
    startsWithSignal(end.kind === 'stop' ? end.message : null);

  const report: string[] = [];
  report.push(
    `Hooks received: ${[...counts].map(([event, count]) => `${event} ×${String(count)}`).join(', ') || 'none'}`,
  );
  report.push(
    end.kind === 'stop_failure'
      ? `End of turn: StopFailure, error ${end.error ?? '(none)'}, message "${cut(end.message ?? '')}"`
      : end.kind === 'stop'
        ? `End of turn: Stop, message "${cut(end.message ?? '')}"`
        : 'End of turn: none (no Stop or StopFailure before the deadline)',
  );
  if (failure) {
    report.push(
      `StopFailure error_details: ${cut(JSON.stringify(failure.input?.error_details ?? null))}`,
    );
  }
  report.push(`Transcript entries with an API error or a limit message: ${String(signals.length)}`);
  for (const entry of signals) {
    report.push(
      `  ${String(entry.type)}${entry.isApiErrorMessage === true ? ' (isApiErrorMessage)' : ''}: "${cut(entryText(entry) ?? '')}"`,
    );
  }
  report.push(`Status line inputs: ${String(statusLines.length)}`);
  const latest = statusLines.at(-1);
  for (const window of ['five_hour', 'seven_day'] as const) {
    const data = latest?.rate_limits?.[window];
    if (data) {
      report.push(
        `  ${window}: ${String(data.used_percentage ?? '?')} %, resets ${data.resets_at === undefined ? '?' : new Date(data.resets_at * 1000).toISOString()}`,
      );
    }
  }
  report.push(
    AUTO_CONTINUE.test(screen)
      ? 'Screen: Claude Code says it continues automatically: autoContinueAtUsageLimit: false is NOT honoured'
      : 'Screen: Claude Code does not say it continues automatically',
  );
  for (const line of screenLines.slice(0, 10)) report.push(`  | ${cut(line, 200)}`);
  report.push(
    `Daemon detection: ${
      assessment === null
        ? 'nothing'
        : assessment.kind === 'detected'
          ? `detected, reset ${assessment.resetsAt ?? 'unknown (fallback delay)'}`
          : 'suspected'
    }`,
  );
  report.push(limitSeen ? 'LIMIT CAPTURED' : 'NO LIMIT SEEN: the session answered normally');
  return { report, limitSeen, transcriptPath };
}

/** The global Git user, which Claude Code shows the agent. */
function gitPersonalValues(): PersonalValue[] {
  const read = (key: string) => {
    try {
      return execFileSync('git', ['config', '--global', '--get', key], { encoding: 'utf8' }).trim();
    } catch {
      return '';
    }
  };
  return [
    { kind: 'the global Git user name', value: read('user.name') },
    { kind: 'the global Git e-mail address', value: read('user.email') },
  ];
}

/**
 * Writes the sanitised fixtures, or nothing when personal data or anything that looks like a
 * credential or an account identifier is still found; returns what was found.
 */
function writeFixtures(
  layout: Layout,
  folder: string,
  transcriptPath: string | null,
  report: string,
): string[] {
  const options = { scratch: [realpathSync(layout.scratch), layout.scratch], home: homedir() };
  const rawTranscript = transcriptPath ? text(transcriptPath) : '';
  const files: Record<string, string> = {};
  for (const [name, source] of [
    ['hooks.jsonl', join(layout.record, `hooks-${SESSION}.jsonl`)],
    ['status-line.jsonl', join(layout.record, `status-line-${SESSION}.jsonl`)],
  ] as const) {
    if (existsSync(source)) files[name] = sanitise(text(source), options);
  }
  if (transcriptPath) files['transcript.jsonl'] = sanitise(keptTranscript(rawTranscript), options);
  files['results.txt'] = sanitise(report, options);
  const personal = [
    ...sessionPersonalValues(rawTranscript, readJson(join(layout.claudeConfig, '.claude.json'))),
    ...gitPersonalValues(),
  ];
  const found = [
    ...personalDataFound(files, personal, options.home),
    ...credentialLikeFound(files),
  ];
  if (found.length > 0) return found;
  mkdirSync(folder, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(folder, name), content);
  return [];
}

// Scan.

/** The transcript files changed in the last `days` days, newest first. */
function recentTranscripts(folders: string[], days: number): string[] {
  const since = Date.now() - days * 24 * 3600 * 1000;
  const found: { path: string; time: number }[] = [];
  for (const folder of folders) {
    if (!existsSync(folder)) continue;
    for (const entry of readdirSync(folder, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const path = join(entry.parentPath, entry.name);
      const time = statSync(path).mtimeMs;
      if (time >= since) found.push({ path, time });
    }
  }
  return found.sort((a, b) => b.time - a.time).map((item) => item.path);
}

function scan(days: number): void {
  const home = process.env.HOME || homedir();
  const daemonHome = process.env.ORCHESTRATOR_HOME || join(home, '.orchestrator');
  const folders = [
    join(home, '.claude', 'projects'),
    join(daemonHome, 'claude-config', 'projects'),
  ];
  const options = { scratch: [], home };
  process.stdout.write(
    `Transcripts changed in the last ${String(days)} day(s), in:\n${folders.map((folder) => `  ${sanitise(folder, options)}\n`).join('')}`,
  );
  let total = 0;
  for (const file of recentTranscripts(folders, days)) {
    const lines = text(file).split('\n');
    const matching: string[] = [];
    lines.forEach((line, index) => {
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (isSignalEntry(entry)) matching.push(`${String(index + 1)}: ${sanitise(line, options)}`);
    });
    if (matching.length === 0) continue;
    total += matching.length;
    process.stdout.write(`\n${sanitise(file, options)} (${String(matching.length)} line(s))\n`);
    for (const line of matching) process.stdout.write(`${line}\n`);
  }
  process.stdout.write(
    total === 0
      ? '\nNo API error or usage-limit message found.\n'
      : `\n${String(total)} line(s) found. E-mail addresses, credentials and your home folder are masked.\n`,
  );
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      scratch: { type: 'string' },
      model: { type: 'string' },
      version: { type: 'string' },
      fixtures: { type: 'string' },
      days: { type: 'string' },
    },
  });
  if (positionals[0] === 'scan') {
    const days = Number(values.days ?? '2');
    if (!Number.isFinite(days) || days <= 0) throw new Error('--days must be a positive number');
    scan(days);
    return;
  }
  if (!values.scratch) throw new Error('--scratch is required');
  const layout = layoutOf(resolve(values.scratch));
  const model = values.model ?? 'sonnet';
  switch (positionals[0]) {
    case 'prepare':
      prepare(layout);
      return;
    case 'login':
      process.exitCode = await login(
        daemonPaths({ ORCHESTRATOR_HOME: layout.daemonHome, HOME: layout.userHome }),
        (line) => {
          process.stdout.write(`${line}\n`);
        },
      );
      return;
    case 'session':
      await new TrustRegistry(join(layout.claudeConfig, '.claude.json')).ensure(layout.bare);
      process.stdout.write(session(layout, model).join('\0'));
      return;
    case 'evaluate': {
      const { report, limitSeen, transcriptPath } = evaluate(layout, new Date());
      const options = { scratch: [realpathSync(layout.scratch), layout.scratch], home: homedir() };
      const header = [
        `Usage-limit capture, ${new Date().toISOString()}`,
        `Claude Code ${values.version ?? 'unknown'}, model ${model}`,
      ];
      const full = [...header, ...report].map((line) => sanitise(line, options)).join('\n');
      process.stdout.write(`${full}\n`);
      if (!limitSeen) {
        process.stdout.write('No fixtures written: nothing to capture.\n');
        process.exitCode = 2;
        return;
      }
      if (!values.fixtures) return;
      const folder = resolve(values.fixtures);
      const found = writeFixtures(layout, folder, transcriptPath, `${full}\n`);
      if (found.length > 0) {
        process.stdout.write(`FIXTURES NOT WRITTEN: ${found.join('; ')}. Nothing was written.\n`);
        process.exitCode = 3;
        return;
      }
      const inRepository = relative(repository, folder);
      process.stdout.write(
        `Fixtures written to: ${inRepository.startsWith('..') ? sanitise(folder, options) : inRepository}\n`,
      );
      return;
    }
    default:
      throw new Error(
        'usage: usage-limit-probe.ts prepare|login|session|evaluate --scratch <folder> | scan [--days <n>]',
      );
  }
}

await main();

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { SETTINGS } from '@orchestrator/protocol';
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
  keptTranscript,
  personalDataFound,
  sanitise,
  sessionPersonalValues,
  type PersonalValue,
} from './claude-code-probe-fixtures.js';

// The helper of the Claude Code probe (lot 2 plan, step H), called by
// `tools/smoke/claude-code-probe.sh` only. It builds everything from the daemon's own code (login,
// settings generation, argument list, trust), so the probe checks what runs will use:
//
//   prepare  --scratch <folder>                  the layout, the test repository and the tokens
//   login    --scratch <folder>                  `orchestrator-daemon login` on the probe's folder
//   session  --scratch <folder> --name <name> --model <model>
//                                                a session's files; prints its arguments, NUL-separated
//   evaluate --scratch <folder> --version <v> --model <model> --fixtures <folder>
//                                                prints one line per check, writes the fixtures
//
// Sessions: `control` starts with no message (no quota) and a made-up setting, to see whether
// Claude Code reports settings it does not know; `probe` sends the one prompt.

/** A setting no Claude Code version knows: the control of check 5. */
const CONTROL_KEY = 'orchestratorProbeUnknownSetting';

/** The prompt's actions, found again in the hook payloads (owner's decision, step H). */
const MARKER_COMMAND = './probe-marker.sh';
const DENIED_FILE = 'config.json';
const CONTROL_FILE = 'control.txt';
const MCP_TOOL = 'mcp__orchestrator__ping';

/** Claude Code's refusals (2.1.283): a matching rule, or `dontAsk` mode refusing what no rule allows. */
const RULE_REFUSAL = /^Permission to use \w+ with command .+ has been denied\.?$/s;
const DONT_ASK_REFUSAL = /don't ask mode/i;

/** Words of a line reporting a setting as refused or ignored. */
const REPORTED =
  /invalid|unknown|unrecogni[sz]ed|not (allowed|recognized|supported|valid)|ignor(ed|ing)|warning|error/i;

const recorderScript = join(import.meta.dirname, 'claude-code-probe-recorder.ts');
const tsxCli = createRequire(join(import.meta.dirname, '..', 'package.json')).resolve('tsx/cli');

interface Layout {
  scratch: string;
  userHome: string;
  daemonHome: string;
  claudeConfig: string;
  record: string;
  bare: string;
  worktrees: Record<'probe' | 'control', string>;
  tokens: { denied: string; control: string };
}

function layoutOf(scratch: string): Layout {
  const userHome = join(scratch, 'home');
  const paths = daemonPaths({
    ORCHESTRATOR_HOME: join(userHome, '.orchestrator'),
    HOME: userHome,
    XDG_CONFIG_HOME: join(userHome, '.config'),
  });
  const saved = readJson(join(scratch, 'tokens.json')) as Layout['tokens'] | undefined;
  return {
    scratch,
    userHome,
    daemonHome: paths.home,
    claudeConfig: paths.claudeConfig,
    record: join(scratch, 'record'),
    bare: join(paths.home, 'repos', 'probe', 'probe.git'),
    worktrees: {
      probe: join(paths.home, 'worktrees', 'probe'),
      control: join(paths.home, 'worktrees', 'control'),
    },
    tokens: saved ?? { denied: '', control: '' },
  };
}

/** The daemon's hook, status line and MCP commands, pointed at the recorder. */
function recorderCommand(layout: Layout): string[] {
  return [process.execPath, tsxCli, recorderScript, '--log', layout.record];
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Probe', '-c', 'user.email=probe@localhost', ...args], {
    cwd,
    stdio: ['ignore', 'ignore', 'pipe'],
  });

/**
 * The daemon's layout in the scratch folder: `home/.orchestrator` with `config.json` (denied) and
 * `control.txt` (no deny rule) next to the worktrees, and a repository whose `.claude/settings.json`
 * allows the marker command and declares a hook, and whose `.mcp.json` declares a server.
 */
function prepare(layout: Layout): void {
  const tokens = {
    denied: `PROBE-DENIED-${randomBytes(6).toString('hex')}`,
    control: `PROBE-CONTROL-${randomBytes(6).toString('hex')}`,
  };
  writeFileSync(join(layout.scratch, 'tokens.json'), JSON.stringify(tokens));
  mkdirSync(layout.record, { recursive: true });
  mkdirSync(layout.daemonHome, { recursive: true, mode: 0o700 });
  writeFileSync(join(layout.daemonHome, DENIED_FILE), `${tokens.denied}\n`);
  writeFileSync(join(layout.daemonHome, CONTROL_FILE), `${tokens.control}\n`);

  const source = join(layout.scratch, 'source');
  mkdirSync(join(source, '.claude'), { recursive: true });
  const recorder = recorderCommand(layout);
  const [command = '', ...args] = recorder;
  writeFileSync(join(source, 'README.md'), '# Claude Code probe\n');
  writeFileSync(
    join(source, MARKER_COMMAND),
    `#!/bin/sh\ntouch ${shellCommand([join(layout.record, 'marker-command-ran')])}\necho "marker command ran"\n`,
  );
  chmodSync(join(source, MARKER_COMMAND), 0o755);
  writeFileSync(
    join(source, '.claude', 'settings.json'),
    `${JSON.stringify(
      {
        permissions: { allow: [`Bash(${MARKER_COMMAND})`, `Bash(${MARKER_COMMAND} *)`] },
        hooks: Object.fromEntries(
          ['SessionStart', 'PreToolUse'].map((event) => [
            event,
            [
              {
                hooks: [
                  {
                    type: 'command',
                    command: shellCommand([...recorder, 'hook', event, '--run', 'repo']),
                  },
                ],
              },
            ],
          ]),
        ),
        enableAllProjectMcpServers: true,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(source, '.mcp.json'),
    `${JSON.stringify(
      {
        mcpServers: {
          'repo-marker': { type: 'stdio', command, args: [...args, 'mcp', '--run', 'repo'] },
        },
      },
      null,
      2,
    )}\n`,
  );
  git(source, 'init', '-q', '-b', 'main');
  git(source, 'add', '-A');
  git(source, 'commit', '-qm', 'Probe repository');
  // A bare clone and worktrees, as the daemon makes them (05, section 4.2.1).
  mkdirSync(dirname(layout.bare), { recursive: true });
  git(layout.scratch, 'clone', '-q', '--bare', source, layout.bare);
  for (const [name, worktree] of Object.entries(layout.worktrees)) {
    git(layout.bare, 'worktree', 'add', '-q', '-b', `probe/${name}`, worktree, 'main');
  }
}

function prompt(layout: Layout): string {
  return [
    'This is a short automated check of Claude Code settings. Do these four actions in order, each exactly once, then reply with the single word DONE. Some actions are expected to be refused: do not retry them, explain them or try another way.',
    `1. Run this command with the Bash tool: ${MARKER_COMMAND}`,
    `2. Run this command with the Bash tool: cat ${join(layout.daemonHome, DENIED_FILE)}`,
    `3. Run this command with the Bash tool: cat ${join(layout.daemonHome, CONTROL_FILE)}`,
    '4. Call the tool named ping of every MCP server you have (use ToolSearch to find them if needed).',
  ].join('\n');
}

/** A session's files, from the daemon's generation; returns its arguments. */
function session(layout: Layout, name: 'probe' | 'control', model: string): string[] {
  const folder = join(layout.daemonHome, 'runs', name);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const selfCommand = recorderCommand(layout);
  const control = name === 'control' ? { [CONTROL_KEY]: false } : {};
  const settings = join(folder, 'settings.json');
  const mcpConfig = join(folder, 'mcp.json');
  writeJsonAtomic(settings, {
    ...runSettings(
      { home: layout.daemonHome, userHome: layout.userHome },
      {
        runId: name,
        profile: {
          key: 'web_dev',
          version: 1,
          instructions: '',
          model,
          // Allowed, so that only a deny rule can refuse `cat` (check 3).
          allowedTools: ['Bash(cat *)'],
        },
      },
      selfCommand,
    ),
    // Approved, so that only --strict-mcp-config keeps the repository's server out (check 2).
    enableAllProjectMcpServers: true,
    ...control,
  });
  writeJsonAtomic(
    mcpConfig,
    runMcpConfig(name, selfCommand, {
      claudeCodeMcpToolTimeoutSeconds: SETTINGS.claudeCodeMcpToolTimeoutSeconds.default,
    } as Parameters<typeof runMcpConfig>[2]),
  );
  // The daemon's user settings; the control session adds its made-up key there too.
  const userSettings = writeUserSettings(layout.claudeConfig);
  const current = Object.entries(readJson(userSettings) as Record<string, unknown>).filter(
    ([key]) => key !== CONTROL_KEY,
  );
  writeJsonAtomic(userSettings, { ...Object.fromEntries(current), ...control });
  const args = claudeArguments({
    mcpConfig,
    settings,
    model,
    instructions: 'You are taking part in an automated check. Follow the numbered steps literally.',
    resumeSessionId: null,
    message: name === 'probe' ? prompt(layout) : '',
  });
  const end = args.indexOf('--');
  const debug = ['--debug-file', join(layout.scratch, `debug-${name}.log`)];
  return name === 'probe'
    ? [...args.slice(0, end), ...debug, ...args.slice(end)]
    : [...args.slice(0, end), ...debug];
}

// Evaluation.

interface Recorded {
  event: string;
  input: Record<string, unknown>;
}

/** A string field of a payload, or ''. */
const field = (value: unknown): string => (typeof value === 'string' ? value : '');

function lines(file: string): string[] {
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
}

function jsonLines(file: string): Record<string, unknown>[] {
  return lines(file).flatMap((line) => {
    try {
      return [JSON.parse(line) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
}

function text(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

interface ToolCall {
  name: string;
  command: string;
}

/** Tool calls as the `PreToolUse` payloads show them. */
function hookCalls(hooks: Recorded[]): ToolCall[] {
  return hooks
    .filter((hook) => hook.event === 'PreToolUse')
    .map((hook) => ({
      name: field(hook.input.tool_name),
      command: field((hook.input.tool_input as { command?: unknown } | undefined)?.command),
    }));
}

/** Tool calls as the transcript shows them: used when a hook payload is missing. */
function transcriptCalls(transcript: Record<string, unknown>[]): ToolCall[] {
  return transcript.flatMap((entry) => {
    const content = (entry.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) return [];
    return (content as { type?: string; name?: string; input?: { command?: unknown } }[])
      .filter((part) => part.type === 'tool_use')
      .map((part) => ({ name: part.name ?? '', command: field(part.input?.command) }));
  });
}

/** The text of each Bash call's result in the transcript, with its command. */
function bashResults(transcript: Record<string, unknown>[]): { command: string; result: string }[] {
  const commands = new Map<string, string>();
  const results: { command: string; result: string }[] = [];
  for (const entry of transcript) {
    const content = (entry.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content as {
      type?: string;
      id?: string;
      name?: string;
      input?: { command?: unknown };
      tool_use_id?: string;
      content?: unknown;
    }[]) {
      if (part.type === 'tool_use' && part.name === 'Bash' && part.id) {
        commands.set(part.id, field(part.input?.command));
      }
      const command = part.tool_use_id ? commands.get(part.tool_use_id) : undefined;
      if (part.type === 'tool_result' && command !== undefined) {
        const result = Array.isArray(part.content)
          ? (part.content as { text?: unknown }[]).map((item) => field(item.text)).join('')
          : field(part.content);
        results.push({ command, result: result.trim() });
      }
    }
  }
  return results;
}

/** How a `cat` of `file` ended: read, refused by a rule, refused by `dontAsk` mode, or unknown. */
function catOutcome(
  results: { command: string; result: string }[],
  file: string,
  token: string,
  seen: string,
): 'read' | 'rule' | 'dontAsk' | 'unknown' {
  if (seen.includes(token)) return 'read';
  const refusals = results.filter((item) => item.command.includes(file)).map((item) => item.result);
  if (refusals.some((text) => RULE_REFUSAL.test(text))) return 'rule';
  if (refusals.some((text) => DONT_ASK_REFUSAL.test(text))) return 'dontAsk';
  return 'unknown';
}

type Verdict = 'PASS' | 'FAIL' | 'NOT ATTEMPTED' | 'INFO';
interface Check {
  verdict: Verdict;
  title: string;
  detail: string;
}

function evaluate(layout: Layout): { checks: Check[]; transcriptPath: string | null } {
  const hooks = jsonLines(join(layout.record, 'hooks-probe.jsonl')) as unknown as Recorded[];
  const start = hooks.find((hook) => hook.event === 'SessionStart');
  const transcriptPath =
    typeof start?.input.transcript_path === 'string' ? start.input.transcript_path : null;
  const transcriptText = transcriptPath ? text(transcriptPath) : '';
  const transcript = transcriptPath ? jsonLines(transcriptPath) : [];
  const fromHooks = hookCalls(hooks);
  const fromTranscript = transcriptCalls(transcript);
  /** Whether an action was attempted, and where it was seen. */
  const attempted = (match: (call: ToolCall) => boolean): string | null =>
    fromHooks.some(match)
      ? 'hook payload'
      : fromTranscript.some(match)
        ? 'transcript only, no PreToolUse payload'
        : null;
  const bash = (part: string) => (call: ToolCall) =>
    call.name === 'Bash' && call.command.includes(part);
  const seen = `${transcriptText}\n${text(join(layout.record, 'hooks-probe.jsonl'))}`;
  const checks: Check[] = [];

  // 1. --setting-sources user ignores the repository's settings.
  {
    const title =
      'repository settings ignored (--setting-sources user): its allow rule and hook did not apply';
    const ran = existsSync(join(layout.record, 'marker-command-ran'));
    const hookRan = existsSync(join(layout.record, 'hooks-repo.jsonl'));
    const where = attempted(bash(MARKER_COMMAND));
    checks.push(
      ran || hookRan
        ? {
            verdict: 'FAIL',
            title,
            detail: [ran && 'the marker command ran', hookRan && "the repository's hook ran"]
              .filter(Boolean)
              .join(', '),
          }
        : where
          ? {
              verdict: 'PASS',
              title,
              detail: `marker command refused, no repository hook (${where})`,
            }
          : { verdict: 'NOT ATTEMPTED', title, detail: 'the agent never ran the marker command' },
    );
  }

  // 2. --strict-mcp-config ignores .mcp.json.
  {
    const title = 'repository MCP server ignored (--strict-mcp-config): not started, not offered';
    const started = existsSync(join(layout.record, 'mcp-started-repo'));
    const offered = [...fromHooks, ...fromTranscript].some((call) =>
      call.name.startsWith('mcp__repo'),
    );
    const where = attempted((call) => call.name === MCP_TOOL);
    checks.push(
      started || offered
        ? {
            verdict: 'FAIL',
            title,
            detail: [
              started && 'the repository server was started',
              offered && 'its tool was called',
            ]
              .filter(Boolean)
              .join(', '),
          }
        : where
          ? { verdict: 'PASS', title, detail: `only the --mcp-config server was used (${where})` }
          : { verdict: 'NOT ATTEMPTED', title, detail: 'the agent never called the ping tool' },
    );
  }

  // 3. A deny rule refuses cat on the daemon's folder. Its refusal message is the rule's, while
  // the control file, which no rule covers, is read or refused by `dontAsk` mode (owner's
  // decision after the first run: `dontAsk` refuses a Bash command reading outside the working
  // folder even when an allow rule matches it).
  {
    const title = 'cat on the denied file refused by a deny rule';
    const denied = attempted(bash(DENIED_FILE));
    const control = attempted(bash(CONTROL_FILE));
    const results = bashResults(transcript);
    const deniedOutcome = catOutcome(results, DENIED_FILE, layout.tokens.denied, seen);
    const controlOutcome = catOutcome(results, CONTROL_FILE, layout.tokens.control, seen);
    const controlText =
      controlOutcome === 'read'
        ? 'the control file next to it was read'
        : 'the control file next to it was refused by dontAsk mode';
    checks.push(
      deniedOutcome === 'read'
        ? {
            verdict: 'FAIL',
            title,
            detail: 'the denied file was read (its content is in the transcript)',
          }
        : !denied || !control
          ? {
              verdict: 'NOT ATTEMPTED',
              title,
              detail: `the agent never ran ${[
                !denied && `cat ${DENIED_FILE}`,
                !control && `cat ${CONTROL_FILE}`,
              ]
                .filter(Boolean)
                .join(' or ')}`,
            }
          : deniedOutcome !== 'rule'
            ? {
                verdict: 'FAIL',
                title,
                detail:
                  deniedOutcome === 'dontAsk'
                    ? 'refused by dontAsk mode, not by the deny rule'
                    : 'no refusal message found in the transcript',
              }
            : controlOutcome === 'read' || controlOutcome === 'dontAsk'
              ? {
                  verdict: 'PASS',
                  title,
                  detail: `refused with the rule's message, while ${controlText} (${denied})`,
                }
              : {
                  verdict: 'FAIL',
                  title,
                  detail:
                    controlOutcome === 'rule'
                      ? 'the control file was refused by a rule too: a deny rule covers more than it should'
                      : 'no outcome found in the transcript for the control file',
                },
    );
  }

  // 4. The status line input.
  {
    const title = 'status line input has rate_limits and cost';
    const inputs = jsonLines(join(layout.record, 'status-line-probe.jsonl')).map(
      (entry) => entry.input as Record<string, unknown>,
    );
    const full = inputs.some((input) => 'rate_limits' in input && 'cost' in input);
    const missing = ['rate_limits', 'cost'].filter((key) => !inputs.some((input) => key in input));
    checks.push(
      full
        ? {
            verdict: 'PASS',
            title,
            detail: `${String(inputs.length)} status line input(s) recorded`,
          }
        : {
            verdict: 'FAIL',
            title,
            detail:
              inputs.length === 0
                ? 'the status line command never ran'
                : `missing in every input: ${missing.join(', ') || 'both in one input'}`,
          },
    );
  }

  // 5. autoContinueAtUsageLimit: Claude Code reports no unknown key (the control shows it), so
  // nothing proves the name before a real usage limit: INFO, or FAIL when the key is reported
  // (owner's decision after the first run; 05, section 4.10).
  {
    const title =
      'autoContinueAtUsageLimit: no settings problem reported (information only: the usage-limit capture proves it)';
    const reports = (name: string, key: string) =>
      [
        ...lines(join(layout.scratch, `debug-${name}.log`)),
        ...lines(join(layout.scratch, `pane-${name}.txt`)),
      ].filter((line) => line.includes(key) && REPORTED.test(line));
    const controlStarted = jsonLines(join(layout.record, 'hooks-control.jsonl')).some(
      (entry) => entry.event === 'SessionStart',
    );
    const reported = reports('probe', 'autoContinueAtUsageLimit');
    const settingsError = text(join(layout.scratch, 'pane-probe.txt')).includes('Settings Error');
    const controlReported = reports('control', CONTROL_KEY);
    checks.push(
      reported.length > 0 || settingsError
        ? {
            verdict: 'FAIL',
            title,
            detail: `reported: ${reported[0]?.trim().slice(0, 200) ?? 'a Settings Error dialog'}`,
          }
        : {
            verdict: 'INFO',
            title,
            detail: !controlStarted
              ? 'the control session never started'
              : controlReported.length === 0
                ? `the made-up key ${CONTROL_KEY} was not reported either`
                : `the made-up key was reported: ${controlReported[0]?.trim().slice(0, 200) ?? ''}`,
          },
    );
  }
  return { checks, transcriptPath };
}

/** The global Git user, which Claude Code shows the agent (never the probe's own `-c` values). */
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
 * Writes the sanitised fixtures, or nothing when the owner's data still appears in one of them
 * (the final guard); returns what was found.
 */
function writeFixtures(
  layout: Layout,
  folder: string,
  transcriptPath: string | null,
  report: string,
): string[] {
  const options = { scratch: [realpathSync(layout.scratch), layout.scratch], home: homedir() };
  const rawTranscript = transcriptPath ? text(transcriptPath) : '';
  const sources: [string, string][] = [
    ['hooks.jsonl', join(layout.record, 'hooks-probe.jsonl')],
    ['status-line.jsonl', join(layout.record, 'status-line-probe.jsonl')],
    ['control-hooks.jsonl', join(layout.record, 'hooks-control.jsonl')],
  ];
  const files: Record<string, string> = {};
  for (const [name, source] of sources) {
    if (existsSync(source)) files[name] = sanitise(text(source), options);
  }
  if (transcriptPath) files['transcript.jsonl'] = sanitise(keptTranscript(rawTranscript), options);
  files['results.txt'] = sanitise(report, options);
  const personal = [
    ...sessionPersonalValues(rawTranscript, readJson(join(layout.claudeConfig, '.claude.json'))),
    ...gitPersonalValues(),
  ];
  const found = personalDataFound(files, personal, options.home);
  if (found.length > 0) return found;
  mkdirSync(folder, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(folder, name), content);
  return [];
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      scratch: { type: 'string' },
      name: { type: 'string' },
      model: { type: 'string' },
      version: { type: 'string' },
      fixtures: { type: 'string' },
    },
  });
  if (!values.scratch) throw new Error('--scratch is required');
  const layout = layoutOf(resolve(values.scratch));
  switch (positionals[0]) {
    case 'prepare':
      prepare(layout);
      return;
    case 'login': {
      const code = await login(
        daemonPaths({ ORCHESTRATOR_HOME: layout.daemonHome, HOME: layout.userHome }),
        (line) => {
          process.stdout.write(`${line}\n`);
        },
      );
      process.exitCode = code;
      return;
    }
    case 'session': {
      const name = values.name === 'control' ? 'control' : 'probe';
      await new TrustRegistry(join(layout.claudeConfig, '.claude.json')).ensure(layout.bare);
      process.stdout.write(session(layout, name, values.model ?? 'haiku').join('\0'));
      return;
    }
    case 'evaluate': {
      const { checks, transcriptPath } = evaluate(layout);
      const width = Math.max(...checks.map((check) => check.verdict.length));
      const report = [
        `Claude Code probe, ${new Date().toISOString()}`,
        `Claude Code ${values.version ?? 'unknown'}, model ${values.model ?? 'haiku'}`,
        ...checks.map(
          (check, index) =>
            `${String(index + 1)}. ${check.verdict.padEnd(width)}  ${check.title}: ${check.detail}`,
        ),
      ].join('\n');
      process.stdout.write(`${report}\n`);
      const verdicts = new Set(checks.map((check) => check.verdict));
      process.exitCode = verdicts.has('FAIL') ? 1 : verdicts.has('NOT ATTEMPTED') ? 2 : 0;
      if (values.fixtures) {
        const folder = resolve(values.fixtures);
        const found = writeFixtures(layout, folder, transcriptPath, `${report}\n`);
        if (found.length > 0) {
          process.stdout.write(
            `FIXTURES NOT WRITTEN: personal data still found after sanitising (${found.join('; ')}). Nothing was written.\n`,
          );
          process.exitCode = 3;
        } else {
          process.stdout.write(`Fixtures written to: ${relative(process.cwd(), folder)}\n`);
        }
      }
      return;
    }
    default:
      throw new Error(
        'usage: claude-code-probe.ts prepare|login|session|evaluate --scratch <folder>',
      );
  }
}

await main();

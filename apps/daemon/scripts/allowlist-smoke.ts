import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { SETTINGS, parseAgentProfileFile, type AgentProfileFile } from '@orchestrator/protocol';
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
import { TrustRegistry } from '../src/trust.js';
import { profileLines } from './allowlist-smoke-profiles.js';
import {
  personalDataFound,
  sanitise,
  sessionPersonalValues,
  type PersonalValue,
} from './claude-code-probe-fixtures.js';

// The helper of the allowlist smoke test (03, section 6; lot 2 plan, step I), called by
// `tools/smoke/allowlist-smoke.sh` only. Like the Claude Code probe of step H, it builds the
// settings and the argument list from the daemon's own code, with the probe's recorder instead of
// the daemon's hook, status line and MCP commands: what is checked is each default profile's
// allowlist and the settings' deny rules (the hook's rules are tested in CI).
//
//   prepare  --scratch <folder>                 the layout, the scratch project, one worktree per profile
//   login    --scratch <folder>                 `orchestrator-daemon login` on the smoke test's folder
//   profiles --scratch <folder>                 the profile keys, one per line; a profile whose
//                                               allowlist and deny rules are those of an earlier
//                                               one is followed by that profile's key
//   session  --scratch <folder> --name <key> --model <model>
//                                               a session's files; prints its arguments, NUL-separated
//   evaluate --scratch <folder> [--profiles <key,...>]
//                                               prints one line per command and profile

/** The repository's `agents/` folder: the shipped profiles. */
const agentsFolder = resolve(import.meta.dirname, '..', '..', '..', 'agents');
const recorderScript = join(import.meta.dirname, 'claude-code-probe-recorder.ts');
const tsxCli = createRequire(join(import.meta.dirname, '..', 'package.json')).resolve('tsx/cli');

const DENIED_FILE = 'config.json';
const NOTE_FILE = 'smoke-note.txt';
const COMMIT_MESSAGE = 'Allowlist smoke test';

/** Claude Code's refusals (2.1.283): a deny rule, or `dontAsk` mode refusing what no rule allows. */
const REFUSAL = /^Permission to use \w+(?: with command [\s\S]+)? has been denied/;

interface Layout {
  scratch: string;
  userHome: string;
  daemonHome: string;
  claudeConfig: string;
  record: string;
  bare: string;
  worktree: (key: string) => string;
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
    bare: join(paths.home, 'repos', 'smoke', 'smoke.git'),
    worktree: (key) => join(paths.home, 'worktrees', key),
  };
}

/** The shipped default profiles, by key. */
function shippedProfiles(): AgentProfileFile[] {
  return readdirSync(agentsFolder)
    .filter((file) => file.endsWith('.md') && file !== 'common-rules.md')
    .sort()
    .map((file) => parseAgentProfileFile(file, readFileSync(join(agentsFolder, file), 'utf8')));
}

function recorderCommand(layout: Layout): string[] {
  return [process.execPath, tsxCli, recorderScript, '--log', layout.record];
}

/** Git with a made-up identity, so the owner's global Git user never appears. */
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=Allowlist smoke', '-c', 'user.email=smoke@localhost', ...args],
    {
      cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );

/** Scripts that only print a line: no dependency, nothing downloaded. */
const packageJson = {
  name: 'allowlist-smoke',
  version: '1.0.0',
  private: true,
  scripts: Object.fromEntries(
    ['test', 'lint', 'build'].map((script) => [script, `node -e "console.log('${script} ran')"`]),
  ),
};

function prepare(layout: Layout): void {
  mkdirSync(layout.record, { recursive: true });
  mkdirSync(layout.daemonHome, { recursive: true, mode: 0o700 });
  writeFileSync(join(layout.daemonHome, DENIED_FILE), `SMOKE-${randomBytes(6).toString('hex')}\n`);
  const source = join(layout.scratch, 'source');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
  writeFileSync(join(source, 'README.md'), '# Allowlist smoke test\n');
  writeFileSync(join(source, '.gitignore'), 'node_modules/\n');
  git(source, 'init', '-q', '-b', 'main');
  git(source, 'add', '-A');
  git(source, 'commit', '-qm', 'Scratch project');
  mkdirSync(dirname(layout.bare), { recursive: true });
  git(layout.scratch, 'clone', '-q', '--bare', source, layout.bare);
  // The agent commits in the worktrees: a made-up identity, as the daemon sets its own (04, section 4).
  execFileSync('git', ['config', 'user.name', 'Allowlist smoke'], { cwd: layout.bare });
  execFileSync('git', ['config', 'user.email', 'smoke@localhost'], { cwd: layout.bare });
  for (const profile of shippedProfiles()) {
    git(
      layout.bare,
      'worktree',
      'add',
      '-q',
      '-b',
      `smoke/${profile.key}`,
      layout.worktree(profile.key),
      'main',
    );
  }
}

/** A command the smoke test asks for, with what the profile's allowlist must do with it. */
interface Check {
  /** What the prompt asks. */
  action: string;
  expect: 'allowed' | 'refused';
  /** Whether a tool call is this action. */
  matches: (call: ToolCall) => boolean;
}

interface ToolCall {
  id: string | null;
  name: string;
  input: Record<string, unknown>;
}

const commandOf = (call: ToolCall) =>
  typeof call.input.command === 'string' ? call.input.command.trim() : '';

function bash(command: string, expected: Check['expect']): Check {
  return {
    action: `Run this command with the Bash tool: ${command}`,
    expect: expected,
    matches: (call) => call.name === 'Bash' && commandOf(call) === command,
  };
}

/**
 * What a builder needs (install, build, test, lint, an edit, a commit: 03, section 6), then what
 * no profile may do: reach the network outside package managers, gain rights, run containers, and
 * read the daemon's folder.
 */
function checks(layout: Layout): Check[] {
  return [
    bash('pnpm install', 'allowed'),
    bash('pnpm test', 'allowed'),
    bash('pnpm run lint', 'allowed'),
    bash('pnpm run build', 'allowed'),
    bash('npm test', 'allowed'),
    bash('node --version', 'allowed'),
    bash('mkdir -p src', 'allowed'),
    bash('ls', 'allowed'),
    {
      action: `Create the file ${NOTE_FILE} with the Write tool, containing the word smoke`,
      expect: 'allowed',
      matches: (call) =>
        call.name === 'Write' &&
        typeof call.input.file_path === 'string' &&
        call.input.file_path.endsWith(NOTE_FILE),
    },
    bash('git status', 'allowed'),
    bash(`git add ${NOTE_FILE}`, 'allowed'),
    bash(`git commit -m "${COMMIT_MESSAGE}"`, 'allowed'),
    bash('git log --oneline -1', 'allowed'),
    // Before the other refusals: a model may skip the last step (`haiku` did, lot 2 step N), and
    // the machine's key matters most.
    {
      ...bash(`cat ${join(layout.daemonHome, DENIED_FILE)}`, 'refused'),
      // Whatever path form the agent writes it with.
      matches: (call) => call.name === 'Bash' && /^cat \S*config\.json$/.test(commandOf(call)),
    },
    bash('curl -sI https://example.com', 'refused'),
    bash('sudo true', 'refused'),
    bash('docker ps', 'refused'),
  ];
}

function prompt(layout: Layout): string {
  return [
    'This is a short automated check of which commands are allowed. Do these steps in order, each exactly once, then reply with the single word DONE. Some steps are expected to be refused: do not retry them, explain them or try another way.',
    ...checks(layout).map((check, index) => `${String(index + 1)}. ${check.action}`),
  ].join('\n');
}

/** A profile's session files, from the daemon's generation; returns its arguments. */
function session(layout: Layout, profile: AgentProfileFile, model: string): string[] {
  const folder = join(layout.daemonHome, 'runs', profile.key);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const selfCommand = recorderCommand(layout);
  const settings = join(folder, 'settings.json');
  const mcpConfig = join(folder, 'mcp.json');
  writeJsonAtomic(
    settings,
    runSettings(
      { home: layout.daemonHome, userHome: layout.userHome },
      {
        runId: profile.key,
        profile: {
          key: profile.key,
          version: 1,
          instructions: '',
          model,
          allowedTools: profile.allowedTools,
        },
      },
      selfCommand,
    ),
  );
  writeJsonAtomic(
    mcpConfig,
    runMcpConfig(profile.key, selfCommand, {
      claudeCodeMcpToolTimeoutSeconds: SETTINGS.claudeCodeMcpToolTimeoutSeconds.default,
    } as Parameters<typeof runMcpConfig>[2]),
  );
  writeUserSettings(layout.claudeConfig);
  return claudeArguments({
    mcpConfig,
    settings,
    model,
    instructions: 'You are taking part in an automated check. Follow the numbered steps literally.',
    resumeSessionId: null,
    message: prompt(layout),
  });
}

// Evaluation.

function text(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

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

interface Recorded {
  event: string;
  input: Record<string, unknown>;
}

/** Tool calls and their results as the transcript shows them. */
function transcriptCalls(transcript: Record<string, unknown>[]) {
  const calls: ToolCall[] = [];
  const results = new Map<string, string>();
  for (const entry of transcript) {
    const content = (entry.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content as {
      type?: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
      tool_use_id?: string;
      content?: unknown;
    }[]) {
      if (part.type === 'tool_use') {
        calls.push({ id: part.id ?? null, name: part.name ?? '', input: part.input ?? {} });
      }
      if (part.type === 'tool_result' && part.tool_use_id) {
        const result = Array.isArray(part.content)
          ? (part.content as { text?: unknown }[])
              .map((item) => (typeof item.text === 'string' ? item.text : ''))
              .join('')
          : typeof part.content === 'string'
            ? part.content
            : '';
        results.set(part.tool_use_id, result.trim());
      }
    }
  }
  return { calls, results };
}

type Verdict = 'PASS' | 'FAIL' | 'NOT ATTEMPTED';
interface Line {
  profile: string;
  verdict: Verdict;
  action: string;
  detail: string;
}

function evaluateProfile(layout: Layout, key: string): { lines: Line[]; transcript: string } {
  const hooks = jsonLines(text(join(layout.record, `hooks-${key}.jsonl`))) as unknown as Recorded[];
  const start = hooks.find((hook) => hook.event === 'SessionStart');
  const transcriptPath =
    typeof start?.input.transcript_path === 'string' ? start.input.transcript_path : null;
  const transcript = transcriptPath ? text(transcriptPath) : '';
  const { calls, results } = transcriptCalls(jsonLines(transcript));
  const hookCalls: ToolCall[] = hooks
    .filter((hook) => hook.event === 'PreToolUse')
    .map((hook) => ({
      id: null,
      name: typeof hook.input.tool_name === 'string' ? hook.input.tool_name : '',
      input: (hook.input.tool_input as Record<string, unknown> | undefined) ?? {},
    }));
  const lines = checks(layout).map((check): Line => {
    const line = {
      profile: key,
      action: check.action.replace(/^Run this command with the Bash tool: /, ''),
    };
    const call = calls.find(check.matches);
    if (!call && !hookCalls.some(check.matches)) {
      return { ...line, verdict: 'NOT ATTEMPTED', detail: 'the agent never tried it' };
    }
    const result = call?.id ? results.get(call.id) : undefined;
    if (result === undefined) {
      return { ...line, verdict: 'FAIL', detail: 'tried, but no result found in the transcript' };
    }
    const refused = REFUSAL.test(result);
    const how = refused
      ? /don't ask mode/i.test(result)
        ? 'refused (not in the allowlist)'
        : 'refused by a deny rule'
      : 'allowed';
    const expected = check.expect === 'refused' ? refused : !refused;
    return {
      ...line,
      verdict: expected ? 'PASS' : 'FAIL',
      detail: `${how}, expected ${check.expect}`,
    };
  });
  return { lines, transcript };
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

function evaluate(layout: Layout, keys: string[]): number {
  const options = { scratch: [realpathSync(layout.scratch), layout.scratch], home: homedir() };
  const lines: Line[] = [];
  let transcripts = '';
  for (const key of keys) {
    const result = evaluateProfile(layout, key);
    lines.push(...result.lines);
    transcripts += result.transcript;
  }
  const width = Math.max(...lines.map((line) => line.verdict.length));
  const report = sanitise(
    [
      `Allowlist smoke test, ${new Date().toISOString()}`,
      ...lines.map(
        (line) => `${line.profile}: ${line.verdict.padEnd(width)}  ${line.action}: ${line.detail}`,
      ),
    ].join('\n'),
    options,
  );
  // The recorded files are sanitised in place; the guard then checks them with the report.
  const records = readdirSync(layout.record).map((name) => join(layout.record, name));
  const files: Record<string, string> = { report: report };
  for (const path of records) {
    const sanitised = sanitise(text(path), options);
    writeFileSync(path, sanitised);
    files[path.slice(layout.scratch.length + 1)] = sanitised;
  }
  const personal = [
    ...sessionPersonalValues(transcripts, readJson(join(layout.claudeConfig, '.claude.json'))),
    ...gitPersonalValues(),
  ];
  const found = personalDataFound(files, personal, options.home);
  if (found.length > 0) {
    for (const path of records) rmSync(path, { force: true });
    process.stdout.write(
      `REPORT WITHHELD: personal data still found after sanitising (${found.join('; ')}). The recorded files were deleted.\n`,
    );
    return 3;
  }
  process.stdout.write(`${report}\n`);
  const verdicts = new Set(lines.map((line) => line.verdict));
  return verdicts.has('FAIL') ? 1 : verdicts.has('NOT ATTEMPTED') ? 2 : 0;
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      scratch: { type: 'string' },
      name: { type: 'string' },
      model: { type: 'string' },
      profiles: { type: 'string' },
    },
  });
  if (!values.scratch) throw new Error('--scratch is required');
  const layout = layoutOf(resolve(values.scratch));
  const profiles = shippedProfiles();
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
    case 'profiles':
      process.stdout.write(
        profileLines({ daemonHome: layout.daemonHome, userHome: layout.userHome }, profiles),
      );
      return;
    case 'session': {
      const profile = profiles.find((each) => each.key === values.name);
      if (!profile) throw new Error(`no profile ${String(values.name)}`);
      await new TrustRegistry(join(layout.claudeConfig, '.claude.json')).ensure(layout.bare);
      process.stdout.write(session(layout, profile, values.model ?? 'haiku').join('\0'));
      return;
    }
    case 'evaluate': {
      const keys = values.profiles ? values.profiles.split(',') : profiles.map((each) => each.key);
      process.exitCode = evaluate(layout, keys);
      return;
    }
    default:
      throw new Error(
        'usage: allowlist-smoke.ts prepare|login|profiles|session|evaluate --scratch <folder>',
      );
  }
}

await main();

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { waitFor } from '../testing.js';
import { installFakeClaude, nodeCommand, type FakeClaude } from './install.js';
import type { ScenarioInput } from './scenario.js';

// The fake `claude` on its own, without tmux or the daemon (ADR 0027): its arguments, hooks,
// transcript, MCP client and terminal input are what the daemon's tests rely on.

let root: string;
let fake: FakeClaude;
let work: string;
let config: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fake-claude-'));
  await mkdir(join(root, 'bin'));
  fake = await installFakeClaude(join(root, 'bin'), join(root, 'fake'));
  work = join(root, 'work');
  config = join(root, 'claude-config');
  await mkdir(work);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

/** Settings whose hooks append their input to `hooks.jsonl`, and whose PreToolUse denies `rm`. */
async function writeSettings(): Promise<string> {
  const record = `cat >> ${quote(join(root, 'hooks.jsonl'))}; echo >> ${quote(join(root, 'hooks.jsonl'))}`;
  const hooks = Object.fromEntries(
    ['SessionStart', 'PostToolUse', 'Stop', 'StopFailure', 'Notification', 'SessionEnd'].map(
      (event) => [event, [{ hooks: [{ type: 'command', command: record }] }]],
    ),
  );
  hooks.PreToolUse = [
    {
      hooks: [
        {
          type: 'command',
          command: `${record}; grep -q '"rm ' ${quote(join(root, 'hooks.jsonl'))} && printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"no rm"}}' || true`,
        },
      ],
    },
  ];
  const settings = join(root, 'settings.json');
  await writeFile(
    settings,
    JSON.stringify({
      hooks,
      statusLine: {
        type: 'command',
        command: `cat > ${quote(join(root, 'status-line.json'))}`,
      },
    }),
  );
  return settings;
}

async function writeMcpConfig(): Promise<string> {
  const [command = '', ...args] = nodeCommand('test-mcp-server.ts');
  const file = join(root, 'mcp.json');
  await writeFile(file, JSON.stringify({ mcpServers: { orchestrator: { command, args } } }));
  return file;
}

function launchArgs(settings: string, mcp: string, message: string): string[] {
  return [
    '--mcp-config',
    mcp,
    '--strict-mcp-config',
    '--setting-sources',
    'user',
    '--settings',
    settings,
    '--permission-mode',
    'dontAsk',
    '--model',
    'sonnet',
    '--append-system-prompt',
    'Rules.',
    '--',
    message,
  ];
}

function runFake(args: string[]) {
  const [node = '', ...rest] = nodeCommand('fake-claude.ts');
  const child = spawn(node, [...rest, ...args], {
    cwd: work,
    env: { ...process.env, FAKE_CLAUDE_DIR: fake.folder, CLAUDE_CONFIG_DIR: config },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  const exited = new Promise<number>((resolve) => {
    child.on('exit', (code) => {
      resolve(code ?? 1);
    });
  });
  return { child, exited, stdout: () => stdout, stderr: () => stderr };
}

async function hookInputs(): Promise<Record<string, unknown>[]> {
  const text = await readFile(join(root, 'hooks.jsonl'), 'utf8');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('fake claude', () => {
  it('prints the version of its scenario', async () => {
    await fake.play({ version: '2.1.300 (Claude Code)' });
    const run = runFake(['--version']);
    expect(await run.exited).toBe(0);
    expect(run.stdout()).toBe('2.1.300 (Claude Code)\n');
  });

  it('refuses arguments out of the order of 05 section 4.3', async () => {
    const settings = await writeSettings();
    const mcp = await writeMcpConfig();
    const args = launchArgs(settings, mcp, 'Hello');
    // --settings before --setting-sources.
    const swapped = [
      ...args.slice(0, 3),
      ...args.slice(5, 7),
      ...args.slice(3, 5),
      ...args.slice(7),
    ];
    const run = runFake(swapped);
    expect(await run.exited).toBe(1);
    expect(run.stderr()).toMatch(/expected --setting-sources/);
    expect(await fake.log()).toContainEqual({
      event: 'arguments_refused',
      message: expect.stringMatching(/--setting-sources/) as unknown,
    });
  });

  it("accepts the probe's --debug-file, and a start without a message", async () => {
    await fake.play({ debugLog: ['Settings Warning: unknown key'] });
    const settings = await writeSettings();
    const mcp = await writeMcpConfig();
    const debugFile = join(root, 'debug.log');
    const args = launchArgs(settings, mcp, 'unused').slice(0, -2);
    const run = runFake([...args, '--debug-file', debugFile]);
    // The hook's line, not the file: it exists before the line is written (lot 3 step E1).
    await waitFor(
      async () => existsSync(join(root, 'hooks.jsonl')) && (await hookInputs()).length > 0,
      10_000,
      'SessionStart',
    );
    expect(await readFile(debugFile, 'utf8')).toBe('Settings Warning: unknown key\n');
    expect((await hookInputs()).map((input) => input.hook_event_name)).toEqual(['SessionStart']);
    run.child.kill();
    await run.exited;
    const log = await fake.log();
    expect(log.some((entry) => entry.event === 'arguments_refused')).toBe(false);
    expect(log.some((entry) => entry.event === 'message')).toBe(false);

    // --debug-file comes before --, never after the message.
    const late = runFake([...launchArgs(settings, mcp, 'Hello'), '--debug-file', debugFile]);
    expect(await late.exited).toBe(1);
    expect(late.stderr()).toMatch(/exactly one message/);
  });

  it('plays a scenario: hooks, transcript, MCP call, status line, pasted input, denial', async () => {
    const settings = await writeSettings();
    const mcp = await writeMcpConfig();
    const scenario: ScenarioInput = {
      turns: [
        {
          steps: [
            { do: 'text', text: 'Working.' },
            { do: 'bash', command: 'echo made > made.txt' },
            { do: 'mcp', tool: 'echo', arguments: { said: 'hi' } },
            { do: 'statusLine', input: { cost: { total_cost_usd: 0.5 } } },
            { do: 'transcript', line: 'not json' },
          ],
          end: { kind: 'stopFailure', error: 'rate_limit', message: 'API Error: limit' },
        },
        {
          steps: [
            { do: 'bash', command: 'rm made.txt' },
            { do: 'exit', code: 0 },
          ],
        },
      ],
    };
    await fake.play(scenario);
    const run = runFake(launchArgs(settings, mcp, 'Start'));
    await waitFor(
      async () =>
        (await fake.log()).some((entry) => entry.event === 'hook' && entry.hook === 'StopFailure'),
      20_000,
      'the first turn',
    );
    run.child.stdin.write('\x1b[200~line one\rline two\rline three\x1b[201~\r');
    expect(await run.exited).toBe(0);

    const log = await fake.log();
    expect(log.filter((entry) => entry.event === 'message').map((entry) => entry.text)).toEqual([
      'Start',
      'line one\nline two\nline three',
    ]);
    expect(await readFile(join(work, 'made.txt'), 'utf8')).toBe('made\n');
    expect(log).toContainEqual({
      event: 'mcp',
      tool: 'echo',
      result: { content: [{ type: 'text', text: '{"said":"hi"}' }] },
    });
    expect(log).toContainEqual({ event: 'denied', tool: 'Bash', reason: 'no rm' });
    expect(JSON.parse(await readFile(join(root, 'status-line.json'), 'utf8'))).toMatchObject({
      cost: { total_cost_usd: 0.5 },
    });

    const inputs = await hookInputs();
    expect(inputs.map((input) => input.hook_event_name)).toEqual([
      'SessionStart',
      'PreToolUse',
      'PostToolUse',
      'PreToolUse',
      'PostToolUse',
      'StopFailure',
      'PreToolUse',
      'SessionEnd',
    ]);
    const [start] = inputs;
    expect(start).toMatchObject({ source: 'startup', model: 'sonnet', cwd: work });
    expect(inputs[5]).toMatchObject({
      error: 'rate_limit',
      last_assistant_message: 'API Error: limit',
    });

    // The transcript is where Claude Code keeps it, with the raw line as written.
    const transcript = String(start?.transcript_path);
    expect(transcript).toBe(
      join(
        config,
        'projects',
        work.replace(/[^A-Za-z0-9]/g, '-'),
        `${String(start?.session_id)}.jsonl`,
      ),
    );
    const lines = (await readFile(transcript, 'utf8')).split('\n').filter(Boolean);
    expect(lines).toContain('not json');
    expect(lines.filter((line) => line.includes('"tool_use"'))).toHaveLength(3);
    expect(await readdir(join(config, 'projects'))).toHaveLength(1);
  });
});

describe('the fake log read while the fake writes it', () => {
  it('leaves out a last line not fully written yet', async () => {
    const entry = { event: 'message', text: 'Go on.' };
    const line = JSON.stringify(entry);
    await writeFile(join(fake.folder, 'log.jsonl'), `${line}\n${line.slice(0, 20)}`);
    expect(await fake.log()).toEqual([entry]);
    await writeFile(join(fake.folder, 'log.jsonl'), `${line}\n${line}\n`);
    expect(await fake.log()).toEqual([entry, entry]);
  });
});

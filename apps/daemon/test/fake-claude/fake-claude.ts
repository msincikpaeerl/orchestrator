import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { Scenario, Turn, type FakeLogEntry, type Step, type TurnEnd } from './scenario.js';

// A fake `claude` for the daemon's tests (ADR 0027, working rule 10). It checks the launch
// arguments of 05 section 4.3, runs the hooks and the status line of the run's `settings.json`
// with Claude Code's documented inputs, writes transcript lines where Claude Code writes them,
// calls tools of the MCP server of `mcp.json`, reads messages pasted in its terminal, and plays
// the scenario of its folder (`FAKE_CLAUDE_DIR`, set by the shim that `installFakeClaude` writes).

const folder = process.env.FAKE_CLAUDE_DIR ?? '';
const record = (entry: FakeLogEntry) => {
  appendFileSync(join(folder, 'log.jsonl'), `${JSON.stringify(entry)}\n`);
};

/**
 * The scenario of a run's folder, `scenarios/<folder name>.json`; for a `--resume` launch,
 * `<folder name>.resume.json` first (the probe's resume, lot 5 step 5bis E).
 */
function readScenario(cwd: string, resume: boolean): Scenario {
  const named = (suffix: string) => join(folder, 'scenarios', `${basename(cwd)}${suffix}.json`);
  const file =
    [...(resume ? [named('.resume')] : []), named('')].find((path) => existsSync(path)) ??
    join(folder, 'scenario.json');
  return Scenario.parse(existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {});
}

interface Launch {
  mcpConfig: string;
  settings: string;
  model: string;
  systemPrompt: string;
  resume: string | null;
  debugFile: string | null;
  /** Null for a session started without a message (the probe's startup check). */
  message: string | null;
}

/**
 * The arguments of 05 section 4.3, in that order; anything else is refused. The step H probe
 * (`tools/smoke/claude-code-probe.sh`) also adds `--debug-file` before `--`, and starts its
 * startup check without `--` and a message.
 */
function parseLaunch(args: string[]): Launch | string {
  const rest = [...args];
  const take = (option: string, withValue: boolean): string | null => {
    if (rest[0] !== option) return null;
    rest.shift();
    if (!withValue) return '';
    const value = rest.shift();
    return value === undefined ? null : value;
  };
  const expect = (option: string, withValue: boolean, value?: string): string => {
    const got = take(option, withValue);
    if (got === null) throw new Error(`expected ${option} at "${rest.join(' ')}"`);
    if (value !== undefined && got !== value) throw new Error(`${option} must be ${value}`);
    return got;
  };
  try {
    const mcpConfig = expect('--mcp-config', true);
    expect('--strict-mcp-config', false);
    expect('--setting-sources', true, 'user');
    const settings = expect('--settings', true);
    expect('--permission-mode', true, 'dontAsk');
    const model = expect('--model', true);
    const systemPrompt = expect('--append-system-prompt', true);
    const resume = take('--resume', true);
    const debugFile = take('--debug-file', true);
    if (rest.length === 0) {
      return { mcpConfig, settings, model, systemPrompt, resume, debugFile, message: null };
    }
    expect('--', false);
    if (rest.length !== 1) throw new Error('expected exactly one message after --');
    return { mcpConfig, settings, model, systemPrompt, resume, debugFile, message: rest[0] ?? '' };
  } catch (error) {
    return (error as Error).message;
  }
}

function runShell(
  command: string,
  input: string,
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd,
      env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('close', (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

interface HookCommand {
  type: string;
  command: string;
}
interface Settings {
  hooks?: Record<string, { matcher?: string; hooks: HookCommand[] }[]>;
  statusLine?: HookCommand;
}

/** The MCP client: JSON-RPC over the server's stdin and stdout, one message per line. */
class McpClient {
  private nextId = 1;
  private readonly waiting = new Map<number, (message: Record<string, unknown>) => void>();
  private readonly child;

  constructor(server: { command: string; args?: string[]; env?: Record<string, string> }) {
    this.child = spawn(server.command, server.args ?? [], {
      env: { ...process.env, ...server.env },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      const message = JSON.parse(line) as Record<string, unknown>;
      const answer = this.waiting.get(message.id as number);
      this.waiting.delete(message.id as number);
      answer?.(message);
    });
  }

  request(method: string, params: unknown): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method: string): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  }

  close(): void {
    this.child.kill();
  }
}

class Session {
  readonly id: string;
  readonly transcriptPath: string;
  private readonly settings: Settings;
  private mcp: McpClient | null = null;
  private parent: string | null = null;
  private lastText = '';
  private turn = 0;

  constructor(
    private readonly launch: Launch,
    private readonly scenario: Scenario,
    private readonly cwd: string,
  ) {
    this.id = launch.resume ?? randomUUID();
    this.settings = JSON.parse(readFileSync(launch.settings, 'utf8')) as Settings;
    // Where Claude Code keeps transcripts (05, section 4.5).
    const projects = join(
      process.env.CLAUDE_CONFIG_DIR ?? '',
      'projects',
      cwd.replace(/[^A-Za-z0-9]/g, '-'),
    );
    mkdirSync(projects, { recursive: true });
    this.transcriptPath = join(projects, `${this.id}.jsonl`);
  }

  private write(entry: Record<string, unknown>): void {
    const uuid = randomUUID();
    const line = {
      parentUuid: this.parent,
      sessionId: this.id,
      cwd: this.cwd,
      timestamp: new Date().toISOString(),
      uuid,
      ...entry,
    };
    this.parent = uuid;
    appendFileSync(this.transcriptPath, `${JSON.stringify(line)}\n`);
  }

  async hook(event: string, fields: Record<string, unknown> = {}, tool?: string) {
    const input = {
      session_id: this.id,
      transcript_path: this.transcriptPath,
      cwd: this.cwd,
      permission_mode: this.scenario.permissionMode,
      hook_event_name: event,
      ...fields,
    };
    const results = [];
    for (const group of this.settings.hooks?.[event] ?? []) {
      const matcher = group.matcher ?? '';
      if (tool !== undefined && matcher && matcher !== '*' && !new RegExp(matcher).test(tool)) {
        continue;
      }
      for (const command of group.hooks) {
        const result = await runShell(command.command, JSON.stringify(input), this.cwd);
        record({ event: 'hook', hook: event, exitCode: result.exitCode, stdout: result.stdout });
        results.push(result);
      }
    }
    return results;
  }

  /** Resolves false when a startup dialog is played: the session then never answers. */
  async start(): Promise<boolean> {
    if (this.scenario.noSessionStart) return false;
    await sleep(this.scenario.startDelayMs);
    await this.hook('SessionStart', {
      source: this.launch.resume ? 'resume' : 'startup',
      model: this.launch.model,
    });
    return true;
  }

  /** A tool call: `PreToolUse` (which can deny it), the work, then `PostToolUse`. */
  private async tool(name: string, input: unknown, work: () => Promise<string>): Promise<void> {
    const id = `toolu_${randomUUID().replace(/-/g, '')}`;
    this.write({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    });
    for (const result of await this.hook(
      'PreToolUse',
      { tool_name: name, tool_input: input, tool_use_id: id },
      name,
    )) {
      const reason = denial(result);
      if (reason !== null) {
        record({ event: 'denied', tool: name, reason });
        this.write({
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: id, content: reason, is_error: true }],
          },
        });
        return;
      }
    }
    const output = await work();
    this.write({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, content: output }],
      },
    });
    await this.hook(
      'PostToolUse',
      { tool_name: name, tool_input: input, tool_use_id: id, tool_response: output },
      name,
    );
  }

  private async mcpCall(tool: string, args: Record<string, unknown>): Promise<string> {
    if (!this.mcp) {
      const config = JSON.parse(readFileSync(this.launch.mcpConfig, 'utf8')) as {
        mcpServers: Record<
          string,
          { command: string; args?: string[]; env?: Record<string, string> }
        >;
      };
      const server = Object.values(config.mcpServers)[0];
      if (!server) throw new Error('no MCP server in --mcp-config');
      this.mcp = new McpClient(server);
      await this.mcp.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'fake-claude', version: this.scenario.version },
      });
      this.mcp.notify('notifications/initialized');
      // As Claude Code does: the tools, with their descriptions and input schemas.
      const listed = await this.mcp.request('tools/list', {});
      const tools = (listed.result as { tools?: { name: string; inputSchema?: unknown }[] }).tools;
      record({
        event: 'mcp_tools',
        tools: (tools ?? []).map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema })),
      });
    }
    const answer = await this.mcp.request('tools/call', { name: tool, arguments: args });
    record({ event: 'mcp', tool, result: answer.result ?? answer.error });
    return JSON.stringify(answer.result ?? answer.error);
  }

  private async step(step: Step): Promise<'hang' | 'exit' | 'next'> {
    switch (step.do) {
      case 'text':
        this.lastText = step.text;
        this.write({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: step.text }] },
        });
        return 'next';
      case 'tool':
        await this.tool(step.name, step.input, () => Promise.resolve(step.result));
        return 'next';
      case 'bash':
        await this.tool('Bash', { command: step.command }, async () => {
          const result = await runShell(step.command, '', this.cwd);
          const output = result.stdout + result.stderr;
          record({ event: 'bash', command: step.command, exitCode: result.exitCode, output });
          return output;
        });
        return 'next';
      case 'mcp': {
        const server = 'orchestrator';
        await this.tool(`mcp__${server}__${step.tool}`, step.arguments, () =>
          this.mcpCall(step.tool, step.arguments),
        );
        return 'next';
      }
      case 'statusLine':
        if (this.settings.statusLine) {
          const input = {
            session_id: this.id,
            transcript_path: this.transcriptPath,
            cwd: this.cwd,
            model: { id: this.launch.model, display_name: this.launch.model },
            ...step.input,
            ...(step.fullForSeconds === undefined
              ? {}
              : {
                  rate_limits: {
                    five_hour: {
                      used_percentage: 100,
                      resets_at: Math.floor(Date.now() / 1000) + step.fullForSeconds,
                    },
                  },
                }),
          };
          await runShell(this.settings.statusLine.command, JSON.stringify(input), this.cwd);
        }
        return 'next';
      case 'notification':
        await this.hook('Notification', {
          message: step.message,
          notification_type: step.type,
        });
        return 'next';
      case 'transcript':
        appendFileSync(this.transcriptPath, `${step.line}\n`);
        return 'next';
      case 'apiError':
        this.lastText = step.text;
        this.write({
          type: 'assistant',
          isApiErrorMessage: true,
          message: { role: 'assistant', content: [{ type: 'text', text: step.text }] },
        });
        return 'next';
      case 'sleep':
        await sleep(step.ms);
        return 'next';
      case 'hang':
        return 'hang';
      case 'exit':
        await this.hook('SessionEnd', { reason: 'other' });
        record({ event: 'exit', code: step.code });
        this.mcp?.close();
        process.exit(step.code);
    }
  }

  /** Plays the turn answering one message; resolves false when the session hangs for good. */
  async answer(message: string): Promise<boolean> {
    record({ event: 'message', text: message });
    await this.hook('UserPromptSubmit', {
      prompt: this.scenario.promptTrimmed ? message.trimEnd() : message,
    });
    this.write({
      type: 'user',
      message: { role: 'user', content: message },
      permissionMode: this.scenario.permissionMode,
    });
    const turn =
      this.scenario.turns[this.turn] ?? Turn.parse({ steps: [{ do: 'text', text: 'Done.' }] });
    this.turn++;
    this.lastText = '';
    for (const step of turn.steps) {
      if ((await this.step(step)) === 'hang') return false;
    }
    await this.end(turn.end);
    return true;
  }

  private async end(end: TurnEnd): Promise<void> {
    if (end.kind === 'stop') {
      await this.hook('Stop', { last_assistant_message: this.lastText, stop_hook_active: false });
    } else {
      await this.hook('StopFailure', {
        error: end.error,
        error_details: null,
        last_assistant_message: end.message,
      });
    }
  }
}

/** The reason a `PreToolUse` hook denied a call, or null. */
function denial(result: { exitCode: number; stdout: string; stderr: string }): string | null {
  if (result.exitCode === 2) return result.stderr.trim() || 'denied';
  try {
    const output = JSON.parse(result.stdout) as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    };
    if (output.hookSpecificOutput?.permissionDecision === 'deny') {
      return output.hookSpecificOutput.permissionDecisionReason ?? 'denied';
    }
  } catch {
    // No JSON: not a decision.
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Messages typed or pasted in the terminal. A bracketed paste (`tmux paste-buffer -p`, which the
 * fake asks for as Claude Code does) is one message whatever its lines; Enter sends it.
 */
function readTerminal(onMessage: (text: string) => void): void {
  const input = process.stdin;
  if (input.isTTY) input.setRawMode(true);
  process.stdout.write('\x1b[?2004h');
  input.setEncoding('utf8');
  let pending = '';
  let message = '';
  let pasting = false;
  input.on('data', (chunk: string) => {
    pending += chunk;
    while (pending.length > 0) {
      if (pending.startsWith('\x1b[200~')) {
        pasting = true;
        pending = pending.slice(6);
      } else if (pending.startsWith('\x1b[201~')) {
        pasting = false;
        pending = pending.slice(6);
      } else if ('\x1b[200~'.startsWith(pending) || '\x1b[201~'.startsWith(pending)) {
        // The rest of a paste marker is still coming.
        return;
      } else {
        const char = pending[0] ?? '';
        pending = pending.slice(1);
        if (char === '\x03') process.exit(130);
        if (pasting) message += char === '\r' ? '\n' : char;
        else if (char === '\r' || char === '\n') {
          if (message) onMessage(message);
          message = '';
        } else message += char;
      }
    }
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cwd = process.cwd();
  const scenario = readScenario(cwd, args.includes('--resume'));
  if (args.length === 1 && args[0] === '--version') {
    process.stdout.write(`${scenario.version}\n`);
    return;
  }
  record({
    event: 'start',
    pid: process.pid,
    args,
    cwd,
    env: {
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null,
      TMUX: process.env.TMUX ?? null,
      TMUX_PANE: process.env.TMUX_PANE ?? null,
      GIT_CEILING_DIRECTORIES: process.env.GIT_CEILING_DIRECTORIES ?? null,
      PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? null,
    },
  });
  const launch = parseLaunch(args);
  if (typeof launch === 'string') {
    record({ event: 'arguments_refused', message: launch });
    process.stderr.write(`fake claude: ${launch}\n`);
    process.exit(1);
  }
  if (launch.debugFile !== null) {
    writeFileSync(launch.debugFile, scenario.debugLog.map((line) => `${line}\n`).join(''));
  }
  const session = new Session(launch, scenario, cwd);
  const queue: string[] = [];
  let busy = true;
  let hung = false;
  const next = async () => {
    const message = queue.shift();
    if (message === undefined || hung) {
      busy = false;
      return;
    }
    busy = true;
    hung = !(await session.answer(message));
    await next();
  };
  readTerminal((text) => {
    queue.push(text);
    if (!busy) void next();
  });
  if (!(await session.start())) return;
  if (launch.message && !scenario.firstMessageNotTaken) {
    await sleep(scenario.firstMessageDelayMs);
    queue.unshift(launch.message);
  }
  await next();
}

void main();

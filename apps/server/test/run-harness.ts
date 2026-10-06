import { randomUUID } from 'node:crypto';
import { schema } from '@orchestrator/db';
import {
  CLAUDE_CODE_VALIDATED_VERSION,
  ClaudeAccount,
  EnrollmentResponse,
  Run,
  TicketDetail,
  type McpCall,
  type McpResult,
  type McpToolName,
  type RunStart,
  type RunState,
  type SettingValues,
} from '@orchestrator/protocol';
import { asc, like } from 'drizzle-orm';
import { expect } from 'vitest';
import { enrollToken, ScriptedDaemon } from './daemon-client.js';
import { fullAccount, startFakeGitHub, type FakeGitHub } from './fake-github.js';
import { createOwner, startTestApp, type TestApp } from './helpers.js';

// The application, a ready project `WEB`, a Claude account and scripted daemons, for the tests of
// runs and of the MCP backend (lot 2 step K). Each test calls `start()` and, at its end, `stop()`.

export const TOKEN = 'github_pat_11AAAAAAA0secretTokenValue1234567890';
export const SESSION = '0f7a3c52-9d7e-4e8f-a4b1-111111111111';
export const HEAD = 'a'.repeat(40);
export const COMMITS = [{ hash: 'b'.repeat(40), subject: 'Add the contact form' }];

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export class RunHarness {
  t!: TestApp;
  private github!: FakeGitHub;
  /** The owner's session cookie, `name=value`. */
  cookie = '';
  private readonly daemons: ScriptedDaemon[] = [];
  private readonly heartbeats: NodeJS.Timeout[] = [];
  private started = false;

  /** `daemonSecondMs` shortens the dispatch timeout and the progress interval; daemons beat. */
  async start(
    options: {
      settings?: Partial<SettingValues>;
      daemonSecondMs?: number;
      streamKeepAliveMs?: number;
      gitBaseUrl?: string;
    } = {},
  ) {
    this.started = true;
    this.github = await startFakeGitHub();
    this.github.accounts.set(TOKEN, fullAccount());
    this.t = await startTestApp({
      githubApiUrl: this.github.url,
      listen: true,
      settings: options.settings,
      daemonSecondMs: options.daemonSecondMs,
      streamKeepAliveMs: options.streamKeepAliveMs,
      gitBaseUrl: options.gitBaseUrl,
    });
    this.cookie = await createOwner(this.t.app);
    const saved = await this.call('PUT', '/api/github/token', { token: TOKEN, expiresOn: null });
    expect(saved.statusCode, saved.body).toBe(200);
    await this.t.db.insert(schema.projects).values({
      key: 'WEB',
      name: 'Bakery website',
      slug: 'bakery',
      description: 'A website for the bakery.',
      kind: 'website',
      repoOwner: 'octo-owner',
      repoName: 'bakery',
      repoOrigin: 'created',
      repoPrivate: true,
      defaultBranch: 'main',
      setupStatus: 'ready',
      branchProtection: 'applied',
    });
  }

  async stop() {
    if (!this.started) return;
    this.started = false;
    for (const timer of this.heartbeats.splice(0)) clearInterval(timer);
    for (const daemon of this.daemons.splice(0)) await daemon.close();
    await this.t.close();
    await this.github.close();
  }

  call(method: Method, url: string, payload?: object) {
    return this.t.app.inject({
      method,
      url,
      headers: { cookie: this.cookie },
      ...(payload ? { payload } : {}),
    });
  }

  async createTicket(body: object = {}): Promise<TicketDetail> {
    const response = await this.call('POST', '/api/projects/WEB/tickets', {
      type: 'feature',
      title: 'Contact form',
      description: 'Visitors write to the bakery.',
      acceptanceCriteria: ['The contact page has a form', 'The e-mail address is checked'],
      assignee: 'web_dev',
      ...body,
    });
    expect(response.statusCode, response.body).toBe(201);
    return TicketDetail.parse(response.json());
  }

  async ticket(number = 1): Promise<TicketDetail> {
    const response = await this.call('GET', `/api/projects/WEB/tickets/${String(number)}`);
    expect(response.statusCode, response.body).toBe(200);
    return TicketDetail.parse(response.json());
  }

  async run(id: string): Promise<Run> {
    const response = await this.call('GET', `/api/runs/${id}`);
    expect(response.statusCode, response.body).toBe(200);
    return Run.parse(response.json());
  }

  /** A machine enrolled and connected with its account, sending heartbeats. */
  async machine(name = 'Laptop', maxConcurrentRuns = 1) {
    const created = await this.call('POST', '/api/accounts', {
      label: `${name} account`,
      plan: 'pro',
      maxConcurrentRuns,
    });
    expect(created.statusCode, created.body).toBe(201);
    const account = ClaudeAccount.parse(created.json());
    const response = await this.call('POST', '/api/machines', { name, accountId: account.id });
    expect(response.statusCode, response.body).toBe(201);
    const enrolled = EnrollmentResponse.parse(response.json());
    const token = await enrollToken(this.t.url, enrolled.enrollment.code);
    const daemon = await this.connect(token);
    return { id: enrolled.machine.id, account, token, daemon };
  }

  async connect(token: string) {
    const daemon = await ScriptedDaemon.connect(this.t.url, token);
    this.daemons.push(daemon);
    expect((await daemon.hello()).accepted).toBe(true);
    this.heartbeats.push(
      setInterval(() => {
        if (daemon.isOpen) daemon.heartbeat();
      }, 50),
    );
    return daemon;
  }

  /** **Run now**, acknowledged, then the run `running`: its id and run token. */
  async running(daemon: ScriptedDaemon, number = 1): Promise<{ runId: string; runToken: string }> {
    const response = await this.call('POST', `/api/projects/WEB/tickets/${String(number)}/run`);
    expect(response.statusCode, response.body).toBe(201);
    const created = Run.parse(response.json());
    const start = await daemon.find<RunStart>(
      (message) => message.type === 'run.start' && message.payload.runId === created.id,
      'run.start',
    );
    daemon.send({ type: 'ack', id: start.id, payload: { ok: true } });
    await this.report(daemon, state(created.id, { state: 'preparing' }));
    await this.report(
      daemon,
      state(created.id, { state: 'starting', claudeCodeVersion: CLAUDE_CODE_VALIDATED_VERSION }),
    );
    await this.report(daemon, state(created.id, { state: 'working' }));
    return { runId: created.id, runToken: start.payload.runToken };
  }

  async report(daemon: ScriptedDaemon, message: RunState) {
    const answer = await daemon.request(message);
    expect(answer).toMatchObject({ type: 'ack', payload: { ok: true } });
  }

  /** A tool call as the daemon relays it: the result or the refusal. */
  async tool(
    daemon: ScriptedDaemon,
    runToken: string,
    tool: McpToolName,
    input: object = {},
    workspace?: Extract<McpCall['payload'], { tool: 'ticket_submit' }>['workspace'],
  ): Promise<McpResult['payload']> {
    const payload = (
      tool === 'ticket_submit'
        ? { tool, runToken, input, workspace: workspace ?? cleanWorkspace() }
        : { tool, runToken, input }
    ) as McpCall['payload'];
    const answer = await daemon.request({ type: 'mcp.call', id: randomUUID(), payload });
    if (answer.type !== 'mcp.result') throw new Error(`unexpected ${answer.type}`);
    return answer.payload;
  }

  /** The output of an accepted call; fails the test with the refusal otherwise. */
  async ok(
    daemon: ScriptedDaemon,
    runToken: string,
    tool: McpToolName,
    input: object = {},
  ): Promise<Record<string, unknown>> {
    const result = await this.tool(daemon, runToken, tool, input);
    if (!result.ok) throw new Error(`${tool} refused: ${JSON.stringify(result.error)}`);
    return result.output;
  }

  async events(prefix: string) {
    return this.t.db
      .select()
      .from(schema.events)
      .where(like(schema.events.type, `${prefix}%`))
      .orderBy(asc(schema.events.id));
  }
}

export function cleanWorkspace(
  overrides: { clean?: boolean; commitsAhead?: typeof COMMITS } = {},
): Extract<McpCall['payload'], { tool: 'ticket_submit' }>['workspace'] {
  return {
    clean: overrides.clean ?? true,
    branch: {
      name: 't/1-contact-form',
      head: HEAD,
      commitsAhead: overrides.commitsAhead ?? COMMITS,
    },
    push: null,
    changedFiles: null,
  };
}

export function state(
  runId: string,
  payload:
    | { state: 'preparing' | 'working' | 'idle' | 'waiting_human' | 'quota_paused' }
    | { state: 'starting'; claudeCodeVersion: string | null }
    | { state: 'ended'; reason: Extract<RunState['payload'], { state: 'ended' }>['reason'] },
  sessionAlive = payload.state !== 'ended',
): RunState {
  const base = { runId, at: new Date().toISOString(), claudeSessionId: SESSION, sessionAlive };
  if (payload.state === 'ended') {
    return {
      type: 'run.state',
      id: randomUUID(),
      payload: {
        ...base,
        state: 'ended',
        reason: payload.reason,
        detail: null,
        branch: { name: 't/1-contact-form', head: HEAD, commitsAhead: COMMITS },
        push: null,
        headMoved: null,
        gitConfigRestored: null,
      },
    };
  }
  return { type: 'run.state', id: randomUUID(), payload: { ...base, ...payload } };
}

/** Waits until `check` passes, for what the server does on its own (a timer). */
export async function eventually(what: string, check: () => Promise<void>, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await check();
      return;
    } catch (failure) {
      if (Date.now() > deadline) {
        throw new Error(`${what} not seen within ${String(timeoutMs)} ms`, { cause: failure });
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

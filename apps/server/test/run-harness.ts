import { randomUUID } from 'node:crypto';
import { schema } from '@orchestrator/db';
import {
  CLAUDE_CODE_VALIDATED_VERSION,
  ClaudeAccount,
  EnrollmentResponse,
  Run,
  RunDetail,
  TicketDetail,
  type McpCall,
  type McpResult,
  type McpToolName,
  type RunStart,
  type RunState,
  type SettingValues,
  type WorkspaceFacts,
} from '@orchestrator/protocol';
import { asc, eq, like } from 'drizzle-orm';
import { expect } from 'vitest';
import { enrollToken, ScriptedDaemon } from './daemon-client.js';
import { fullAccount, skeletonWorkflow, startFakeGitHub, type FakeGitHub } from './fake-github.js';
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
  github!: FakeGitHub;
  /** The owner's session cookie, `name=value`. */
  cookie = '';
  private readonly daemons: ScriptedDaemon[] = [];
  private readonly heartbeats: NodeJS.Timeout[] = [];
  private started = false;
  private pushes = 0;
  /** The commit the latest submission pushed on the fake GitHub. */
  lastPushed: string | null = null;
  /** The ticket number of each run token `running` gave. */
  private readonly runTickets = new Map<string, number>();

  /** `daemonSecondMs` shortens the dispatch timeout and the progress interval; daemons beat. */
  async start(
    options: {
      settings?: Partial<SettingValues>;
      daemonSecondMs?: number;
      streamKeepAliveMs?: number;
      gitBaseUrl?: string;
      /** The application's clock, for the CI checks' deadlines (lot 3 step G1a). */
      now?: () => Date;
      /** What the project's CI does by itself: it passes at once unless a test says otherwise. */
      ci?: 'success' | 'queued' | 'none';
    } = {},
  ) {
    this.started = true;
    this.pushes = 0;
    this.lastPushed = null;
    this.github = await startFakeGitHub();
    // The project's repository, where a push the scripted daemon reports lands (`tool`).
    this.github.accounts.set(
      TOKEN,
      fullAccount({
        repositories: [
          { name: 'notes', private: true },
          // The skeleton's CI: its `pull_request` run passes at once by default.
          {
            name: 'bakery',
            private: true,
            files: { 'README.md': '# Bakery\n', '.github/workflows/ci.yml': 'name: CI\n' },
            workflows: [skeletonWorkflow()],
            ci: options.ci ?? 'success',
          },
        ],
      }),
    );
    this.t = await startTestApp({
      githubApiUrl: this.github.url,
      listen: true,
      settings: options.settings,
      daemonSecondMs: options.daemonSecondMs,
      streamKeepAliveMs: options.streamKeepAliveMs,
      gitBaseUrl: options.gitBaseUrl,
      now: options.now,
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

  async run(id: string): Promise<RunDetail> {
    const response = await this.call('GET', `/api/runs/${id}`);
    expect(response.statusCode, response.body).toBe(200);
    return RunDetail.parse(response.json());
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
    this.runTickets.set(start.payload.runToken, number);
    return { runId: created.id, runToken: start.payload.runToken };
  }

  /** **Start review**, acknowledged, then the review run `running`: its id, token and start. */
  async reviewing(
    daemon: ScriptedDaemon,
    number = 1,
  ): Promise<{ runId: string; runToken: string; start: RunStart }> {
    const response = await this.call('POST', `/api/projects/WEB/tickets/${String(number)}/review`);
    expect(response.statusCode, response.body).toBe(201);
    const created = Run.parse(response.json());
    const start = await daemon.find<RunStart>(
      (message) => message.type === 'run.start' && message.payload.runId === created.id,
      'run.start of the review',
    );
    daemon.send({ type: 'ack', id: start.id, payload: { ok: true } });
    await this.report(daemon, state(created.id, { state: 'preparing' }));
    await this.report(
      daemon,
      state(created.id, { state: 'starting', claudeCodeVersion: CLAUDE_CODE_VALIDATED_VERSION }),
    );
    await this.report(daemon, state(created.id, { state: 'working' }));
    return { runId: created.id, runToken: start.payload.runToken, start };
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
    workspace?: WorkspaceFacts,
  ): Promise<McpResult['payload']> {
    let facts = workspace ?? cleanWorkspace();
    // The push the facts report, done on the fake GitHub as the daemon's push would.
    const number = this.runTickets.get(runToken);
    if (tool === 'ticket_submit' && facts.push?.status === 'pushed' && number !== undefined) {
      this.pushes += 1;
      const [ticket] = await this.t.db
        .select({ branch: schema.tickets.branchName })
        .from(schema.tickets)
        .where(eq(schema.tickets.number, number));
      const branch = ticket?.branch ?? facts.branch.name;
      const repo = this.github.repository('octo-owner', 'bakery');
      const exists = this.github.branches(repo).has(branch);
      const pushed = this.github.commit(
        repo,
        branch,
        { [`src/work-${String(this.pushes)}.ts`]: 'export {};\n' },
        'Work of the agent',
        exists ? undefined : 'main',
      );
      // The commit the fake holds is the one pushed: its CI is the submission's (lot 3 step G1a).
      if (facts.push.head === HEAD) {
        facts = {
          ...facts,
          branch: { ...facts.branch, head: pushed },
          push: { status: 'pushed', head: pushed },
        };
      }
      this.lastPushed = pushed;
    }
    const payload = (
      tool === 'ticket_submit'
        ? { tool, runToken, input, workspace: facts }
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

  /**
   * An accepted submission's wait for CI, to its end: the session idle (`waiting_ci`), the wait
   * begun, one CI check by the test, then the daemon's end after `run.stop` `completed`.
   * The project's CI passes at once unless the test said otherwise.
   */
  async ciPasses(daemon: ScriptedDaemon, runId: string) {
    await this.report(daemon, state(runId, { state: 'waiting_ci' }));
    await eventually('the wait for CI begun (the pull request open)', async () => {
      expect((await this.run(runId)).ci?.since).toBeTruthy();
    });
    await this.t.ciTick();
    await daemon.find(
      (message) =>
        message.type === 'run.stop' &&
        message.payload.runId === runId &&
        message.payload.reason === 'completed',
      'run.stop completed',
    );
    await this.report(daemon, state(runId, { state: 'ended', reason: 'submitted' }));
  }

  async events(prefix: string) {
    return this.t.db
      .select()
      .from(schema.events)
      .where(like(schema.events.type, `${prefix}%`))
      .orderBy(asc(schema.events.id));
  }
}

/** The files the tests' reports list, as changed on the branch. */
export const CHANGED_FILES = ['docs/user/contact.md', 'src/contact.test.ts', 'src/contact.ts'];

/**
 * The facts of a protocol 2 daemon at a submission that passes: a clean worktree, commits ahead,
 * the push done and the files the reports list changed (05, section 4.9).
 */
export function cleanWorkspace(
  overrides: Partial<Omit<WorkspaceFacts, 'branch'>> & { commitsAhead?: typeof COMMITS } = {},
): WorkspaceFacts {
  const { commitsAhead, ...facts } = overrides;
  return {
    clean: true,
    branch: {
      name: 't/1-contact-form',
      head: HEAD,
      commitsAhead: commitsAhead ?? COMMITS,
      notOnGitHub: null,
    },
    push: { status: 'pushed', head: HEAD },
    changedFiles: { listed: CHANGED_FILES, count: CHANGED_FILES.length },
    ...facts,
  };
}

export function state(
  runId: string,
  payload:
    | {
        state: 'preparing' | 'working' | 'idle' | 'waiting_ci' | 'waiting_human' | 'quota_paused';
      }
    | { state: 'starting'; claudeCodeVersion: string | null }
    | {
        state: 'ended';
        reason: Extract<RunState['payload'], { state: 'ended' }>['reason'];
        /** A review run's fact: the branch head moved on the machine (05, section 4.9). */
        headMoved?: boolean;
        detail?: string;
      },
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
        detail: payload.detail ?? null,
        branch: { name: 't/1-contact-form', head: HEAD, commitsAhead: COMMITS, notOnGitHub: null },
        push: null,
        headMoved: payload.headMoved ?? null,
        gitConfigRestored: null,
      },
    };
  }
  return { type: 'run.state', id: randomUUID(), payload: { ...base, ...payload } };
}

/** Waits until `check` passes, for what the server does on its own (a timer). */
export async function eventually(
  what: string,
  check: () => Promise<void> | void,
  timeoutMs = 5000,
) {
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

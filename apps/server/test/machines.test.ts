import { schema } from '@orchestrator/db';
import {
  AccountListResponse,
  ApiError,
  CLAUDE_CODE_MIN_VERSION,
  ClaudeAccount,
  DaemonCloseCode,
  EnrollResponse,
  EnrollmentResponse,
  Machine,
  MachineListResponse,
  NeedsYouResponse,
  PROTOCOL_VERSION,
  type SettingValues,
} from '@orchestrator/protocol';
import { asc, eq, like, or } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { markAllOffline } from '../src/machines/gateway.js';
import { SERVER_VERSION } from '../src/version.js';
import { enroll, enrollToken, RefusedConnection, ScriptedDaemon } from './daemon-client.js';
import { createOwner, startTestApp, type TestApp } from './helpers.js';

// Claude accounts, machines, enrollment and the daemon gateway (lot 2 step C; 01 sections 3.8
// and 3.9; 02 section 9; 05 sections 3.1 and 3.2).

/** One second of the heartbeat settings lasts this long in these tests. */
const SECOND_MS = 20;

let t: TestApp;
let cookie: string;
let clock: Date;
const daemons: ScriptedDaemon[] = [];

async function start(
  options: { settings?: Partial<SettingValues>; daemonSecondMs?: number } = {},
): Promise<void> {
  clock = new Date();
  t = await startTestApp({
    listen: true,
    now: () => clock,
    daemonSecondMs: options.daemonSecondMs,
    settings: options.settings,
  });
  cookie = await createOwner(t.app);
}

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.close();
  await t.close();
});

function call(method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown) {
  return t.app.inject({
    method,
    url,
    headers: { cookie },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

function error(response: { json: () => unknown }) {
  return ApiError.parse(response.json()).error;
}

async function createAccount(label = 'Personal Max'): Promise<ClaudeAccount> {
  const response = await call('POST', '/api/accounts', { label, plan: 'max_5x' });
  expect(response.statusCode, response.body).toBe(201);
  return ClaudeAccount.parse(response.json());
}

/** The first account, created when there is none. */
async function anyAccount(): Promise<string> {
  const list = AccountListResponse.parse((await call('GET', '/api/accounts')).json());
  return list.accounts[0]?.id ?? (await createAccount()).id;
}

async function createMachine(name = 'Laptop', accountId?: string) {
  const account = accountId ?? (await anyAccount());
  const response = await call('POST', '/api/machines', { name, accountId: account });
  expect(response.statusCode, response.body).toBe(201);
  return EnrollmentResponse.parse(response.json());
}

async function machine(id: string): Promise<Machine> {
  const response = await call('GET', `/api/machines/${id}`);
  expect(response.statusCode, response.body).toBe(200);
  return Machine.parse(response.json());
}

async function connect(token: string): Promise<ScriptedDaemon> {
  const daemon = await ScriptedDaemon.connect(t.url, token);
  daemons.push(daemon);
  return daemon;
}

/** A machine enrolled and connected: its id, token and daemon. */
async function connectedMachine(name = 'Laptop', accountId?: string) {
  const created = await createMachine(name, accountId);
  const token = await enrollToken(t.url, created.enrollment.code);
  const daemon = await connect(token);
  expect((await daemon.hello()).accepted).toBe(true);
  return { id: created.machine.id, token, daemon };
}

async function machineEvents() {
  const rows = await t.db
    .select()
    .from(schema.events)
    .where(or(like(schema.events.type, 'machine.%'), like(schema.events.type, 'account.%')))
    .orderBy(asc(schema.events.id));
  return rows.map(({ type, payload }) => ({ type, payload }));
}

async function needsYou() {
  const response = await call('GET', '/api/needs-you');
  expect(response.statusCode, response.body).toBe(200);
  return NeedsYouResponse.parse(response.json()).items;
}

/** Waits until `check` passes, for what the server does after a socket event. */
async function eventually(check: () => Promise<void>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await check();
      return;
    } catch (failure) {
      if (Date.now() > deadline) throw failure;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

describe('Claude accounts', () => {
  it('creates, lists and edits accounts, each change with its event', async () => {
    await start();
    const account = await createAccount();
    expect(account).toMatchObject({
      label: 'Personal Max',
      plan: 'max_5x',
      maxConcurrentRuns: 1,
      state: 'available',
      limitedUntil: null,
    });
    const edited = await call('PATCH', `/api/accounts/${account.id}`, {
      label: 'Work Max',
      maxConcurrentRuns: 3,
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(ClaudeAccount.parse(edited.json())).toMatchObject({
      label: 'Work Max',
      maxConcurrentRuns: 3,
    });
    // Nothing changed: no event.
    await call('PATCH', `/api/accounts/${account.id}`, { plan: 'max_5x' });
    const list = AccountListResponse.parse((await call('GET', '/api/accounts')).json());
    expect(list.accounts.map((each) => each.label)).toEqual(['Work Max']);
    expect(await machineEvents()).toEqual([
      {
        type: 'account.created',
        payload: { label: 'Personal Max', plan: 'max_5x', maxConcurrentRuns: 1 },
      },
      {
        type: 'account.updated',
        payload: {
          label: 'Work Max',
          fields: ['label', 'maxConcurrentRuns'],
          previousLabel: 'Personal Max',
          maxConcurrentRuns: 3,
        },
      },
    ]);
  });

  it('refuses a taken label, a maximum outside 1 to 10 and an unknown account', async () => {
    await start();
    const account = await createAccount('Personal');
    const taken = await call('POST', '/api/accounts', { label: ' personal ', plan: 'pro' });
    expect(taken.statusCode).toBe(409);
    expect(error(taken).code).toBe('account_label_taken');
    for (const maxConcurrentRuns of [0, 11, 1.5]) {
      const refused = await call('PATCH', `/api/accounts/${account.id}`, { maxConcurrentRuns });
      expect(refused.statusCode).toBe(400);
    }
    const tooLong = await call('POST', '/api/accounts', { label: 'x'.repeat(81), plan: 'pro' });
    expect(tooLong.statusCode).toBe(400);
    const unknown = await call('PATCH', '/api/accounts/3f1e0e8c-1111-4000-8000-000000000000', {
      plan: 'pro',
    });
    expect(error(unknown).code).toBe('account_not_found');
  });
});

describe('adding a machine and enrolling it', () => {
  it('shows the commands with a one-time code, and the daemon gets its token', async () => {
    await start();
    const { machine: created, enrollment } = await createMachine();
    expect(created).toMatchObject({ name: 'Laptop', state: 'waiting_enrollment', online: false });
    expect(enrollment.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){5}$/);
    expect(enrollment.installCommand).toBe(
      `npm install -g http://localhost:8080/downloads/orchestrator-daemon-${SERVER_VERSION}.tgz`,
    );
    expect(enrollment.enrollCommand).toBe(
      `orchestrator-daemon enroll http://localhost:8080 ${enrollment.code}`,
    );
    const expiresIn = Date.parse(enrollment.expiresAt) - clock.getTime();
    expect(expiresIn).toBe(15 * 60_000);

    // Typed in lower case without dashes: still the same code.
    const { status, body } = await enroll(t.url, enrollment.code.replaceAll('-', '').toLowerCase());
    expect(status).toBe(200);
    const answer = EnrollResponse.parse(body);
    expect(answer).toMatchObject({ machineId: created.id, machineName: 'Laptop' });
    expect((await machine(created.id)).state).toBe('offline');

    // Neither the code nor the token is stored or logged in clear.
    const [row] = await t.db.select().from(schema.machines);
    expect(JSON.stringify(row)).not.toContain(answer.machineToken);
    expect(t.logs.text).not.toContain(answer.machineToken);
    expect(t.logs.text).not.toContain(enrollment.code.replaceAll('-', ''));
    expect(t.logs.text).not.toContain(enrollment.code);
    expect((await machineEvents()).map((event) => event.type)).toEqual([
      'account.created',
      'machine.created',
      'machine.enrollment_code_created',
      'machine.enrolled',
    ]);
  });

  it('refuses an unknown, a reused and an expired code, stating the lifetime', async () => {
    await start({ settings: { loginFailuresBeforeDelay: 10 } });
    const unknown = await enroll(t.url, 'ABCD-EFGH-JKMN-PQRS-TVWX-YZ01');
    expect(unknown.status).toBe(404);
    expect(ApiError.parse(unknown.body).error.code).toBe('enrollment_code_unknown');

    const { enrollment } = await createMachine();
    expect((await enroll(t.url, enrollment.code)).status).toBe(200);
    const reused = await enroll(t.url, enrollment.code);
    expect(reused.status).toBe(409);
    expect(ApiError.parse(reused.body).error.code).toBe('enrollment_code_used');

    const other = await createMachine('Desktop');
    await call('PUT', '/api/settings/enrollmentCodeLifetimeMinutes', { value: 20 });
    clock = new Date(clock.getTime() + 15 * 60_000);
    const expired = await enroll(t.url, other.enrollment.code);
    expect(expired.status).toBe(410);
    expect(ApiError.parse(expired.body).error).toEqual({
      code: 'enrollment_code_expired',
      message:
        'This enrollment code expired: codes are valid for 20 minutes (setting "Enrollment code lifetime"). Generate a new code in Machines',
      setting: { name: 'enrollmentCodeLifetimeMinutes', value: 20 },
    });
    // The machine stays waiting; a new code works and replaces the old one.
    expect((await machine(other.machine.id)).state).toBe('waiting_enrollment');
    const renewed = await call('POST', `/api/machines/${other.machine.id}/enrollment-code`);
    const code = EnrollmentResponse.parse(renewed.json()).enrollment.code;
    expect((await enroll(t.url, other.enrollment.code)).status).toBe(404);
    expect((await enroll(t.url, code)).status).toBe(200);
  });

  it('lets only one of two requests with the same code enroll', async () => {
    await start();
    const { enrollment } = await createMachine();
    const answers = await Promise.all(
      Array.from({ length: 5 }, () => enroll(t.url, enrollment.code)),
    );
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 409, 409, 409, 409]);
  });

  it('delays wrong codes per address without delaying the owner login', async () => {
    await start({ settings: { loginFailuresBeforeDelay: 2, loginFirstDelaySeconds: 30 } });
    await enroll(t.url, 'ABCD-EFGH-JKMN-PQRS-TVWX-YZ01');
    await enroll(t.url, 'ABCD-EFGH-JKMN-PQRS-TVWX-YZ02');
    const { enrollment } = await createMachine();
    // Even a good code waits once the delay started.
    const delayed = await enroll(t.url, enrollment.code);
    expect(delayed.status).toBe(429);
    expect(ApiError.parse(delayed.body).error).toMatchObject({
      code: 'too_many_attempts',
      retryAfterSeconds: 30,
    });
    const login = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '127.0.0.1',
      payload: { username: 'owner', password: 'correct horse battery' },
    });
    expect(login.statusCode).toBe(200);
    const events = await machineEvents();
    expect(events.find((event) => event.type === 'machine.enrollment_throttled')).toEqual({
      type: 'machine.enrollment_throttled',
      payload: { address: '127.0.0.1', failures: 2, delaySeconds: 30 },
    });
    clock = new Date(clock.getTime() + 31_000);
    expect((await enroll(t.url, enrollment.code)).status).toBe(200);
  });

  it('refuses a taken name and an unknown account', async () => {
    await start();
    const account = await createAccount();
    await createMachine('Laptop', account.id);
    const taken = await call('POST', '/api/machines', { name: 'LAPTOP', accountId: account.id });
    expect(error(taken).code).toBe('machine_name_taken');
    const unknown = await call('POST', '/api/machines', {
      name: 'Desktop',
      accountId: '3f1e0e8c-1111-4000-8000-000000000000',
    });
    expect(error(unknown).code).toBe('account_not_found');
  });
});

describe('the daemon connection', () => {
  it('accepts the token, answers hello with the heartbeat interval, and shows it online', async () => {
    await start({ settings: { heartbeatIntervalSeconds: 20 } });
    const created = await createMachine();
    const token = await enrollToken(t.url, created.enrollment.code);
    const daemon = await connect(token);
    const welcome = await daemon.hello({ capabilities: ['git', 'docker', 'git'] });
    expect(welcome).toEqual({
      accepted: true,
      protocolVersion: PROTOCOL_VERSION,
      heartbeatIntervalSeconds: 20,
    });
    const shown = await machine(created.machine.id);
    expect(shown).toMatchObject({
      state: 'online',
      online: true,
      os: 'wsl',
      daemonVersion: '0.3.0',
      claudeCodeSupport: 'supported',
      capabilities: ['docker', 'git'],
      unusable: [],
    });
    const list = MachineListResponse.parse((await call('GET', '/api/machines')).json());
    expect(list.machines.map((each) => each.state)).toEqual(['online']);
    expect(t.logs.text).not.toContain(token);
  });

  it('refuses an unknown token before the WebSocket opens', async () => {
    await start();
    const refused = await ScriptedDaemon.connect(t.url, `omt_${'a'.repeat(43)}`).catch(
      (failure: unknown) => failure,
    );
    expect(refused).toBeInstanceOf(RefusedConnection);
    expect((refused as RefusedConnection).status).toBe(401);
    const none = await ScriptedDaemon.connect(t.url, '').catch((failure: unknown) => failure);
    expect((none as RefusedConnection).status).toBe(401);
  });

  it('disconnects a revoked machine and refuses its token, until a new enrollment', async () => {
    await start();
    const { id, token, daemon } = await connectedMachine();
    const revoked = await call('POST', `/api/machines/${id}/revoke`);
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(Machine.parse(revoked.json())).toMatchObject({ state: 'revoked', online: false });
    expect((await daemon.closed).code).toBe(DaemonCloseCode.revoked);

    // The same token: told it was revoked, then closed.
    const again = await connect(token);
    const welcome = await again.hello();
    expect(welcome).toMatchObject({ accepted: false, reason: 'token_revoked' });
    expect((await again.closed).code).toBe(DaemonCloseCode.revoked);

    // Only a new enrollment code, which makes the old token unknown for good.
    expect(error(await call('POST', `/api/machines/${id}/disable`)).code).toBe('machine_revoked');
    expect(
      error(await call('PUT', `/api/machines/${id}/capabilities`, { capabilities: [] })).code,
    ).toBe('machine_revoked');
    const renewed = EnrollmentResponse.parse(
      (await call('POST', `/api/machines/${id}/enrollment-code`)).json(),
    );
    expect(renewed.machine).toMatchObject({ state: 'waiting_enrollment', revokedAt: null });
    const old = await ScriptedDaemon.connect(t.url, token).catch((failure: unknown) => failure);
    expect((old as RefusedConnection).status).toBe(401);
    const newToken = await enrollToken(t.url, renewed.enrollment.code);
    expect((await (await connect(newToken)).hello()).accepted).toBe(true);

    const types = (await machineEvents()).map((event) => event.type);
    expect(types).toEqual([
      'account.created',
      'machine.created',
      'machine.enrollment_code_created',
      'machine.enrolled',
      'machine.online',
      'machine.revoked',
      'machine.offline',
      'machine.enrollment_code_created',
      'machine.enrolled',
      'machine.online',
    ]);
  });

  it('refuses an incompatible protocol and shows "daemon incompatible" until updated', async () => {
    await start();
    const created = await createMachine();
    const token = await enrollToken(t.url, created.enrollment.code);
    const old = await connect(token);
    const welcome = await old.hello({
      protocolVersion: PROTOCOL_VERSION + 1,
      daemonVersion: '9.0.0',
    });
    expect(welcome).toEqual({
      accepted: false,
      reason: 'protocol_incompatible',
      message: `This daemon speaks protocol version ${String(PROTOCOL_VERSION + 1)}; this server accepts version ${String(PROTOCOL_VERSION)}. Install the daemon of the server's version: npm install -g http://localhost:8080/downloads/orchestrator-daemon-${SERVER_VERSION}.tgz`,
    });
    expect((await old.closed).code).toBe(DaemonCloseCode.incompatible);
    expect(await machine(created.machine.id)).toMatchObject({
      state: 'offline',
      daemonIncompatible: true,
      daemonVersion: '9.0.0',
    });
    expect(await needsYou()).toContainEqual(
      expect.objectContaining({
        type: 'daemon_incompatible',
        daemonVersion: '9.0.0',
        protocolVersion: PROTOCOL_VERSION + 1,
      }),
    );
    // Retrying with the same versions writes no second event.
    const retry = await connect(token);
    await retry.hello({ protocolVersion: PROTOCOL_VERSION + 1, daemonVersion: '9.0.0' });
    await retry.closed;
    const updated = await connect(token);
    expect((await updated.hello()).accepted).toBe(true);
    expect((await machine(created.machine.id)).daemonIncompatible).toBe(false);
    expect((await needsYou()).map((item) => item.type)).not.toContain('daemon_incompatible');
    const types = (await machineEvents()).map((event) => event.type);
    expect(types.filter((type) => type === 'machine.daemon_incompatible')).toHaveLength(1);
  });

  it('keeps a machine with an old Claude Code connected but unusable', async () => {
    await start();
    const created = await createMachine();
    const token = await enrollToken(t.url, created.enrollment.code);
    const daemon = await connect(token);
    const welcome = await daemon.hello({ claudeCodeVersion: '2.1.279' });
    expect(welcome.accepted).toBe(true);
    expect(await machine(created.machine.id)).toMatchObject({
      state: 'online',
      claudeCodeSupport: 'below_minimum',
      unusable: [
        { type: 'claude_code_unsupported', version: '2.1.279', minimum: CLAUDE_CODE_MIN_VERSION },
      ],
    });
    expect(await needsYou()).toContainEqual(
      expect.objectContaining({
        type: 'claude_code_unsupported',
        version: '2.1.279',
        minimum: CLAUDE_CODE_MIN_VERSION,
      }),
    );
    // Missing Claude Code is unsupported too.
    await daemon.close();
    const missing = await connect(token);
    await missing.hello({ claudeCodeVersion: null });
    expect((await machine(created.machine.id)).unusable).toEqual([
      { type: 'claude_code_unsupported', version: null, minimum: CLAUDE_CODE_MIN_VERSION },
    ]);
  });

  it('warns about a Claude Code above the validated version without blocking the machine', async () => {
    await start();
    const created = await createMachine();
    const daemon = await connect(await enrollToken(t.url, created.enrollment.code));
    expect((await daemon.hello({ claudeCodeVersion: '2.9.0' })).accepted).toBe(true);
    expect(await machine(created.machine.id)).toMatchObject({
      claudeCodeSupport: 'above_validated',
      unusable: [],
    });
    const types = (await needsYou()).map((item) => item.type);
    expect(types).not.toContain('claude_code_unsupported');
  });

  it('makes a doctor error, not a warning, a problem for "Needs you"', async () => {
    await start();
    const created = await createMachine();
    const token = await enrollToken(t.url, created.enrollment.code);
    const warned = await connect(token);
    await warned.hello({
      doctor: [
        { name: 'managed settings', status: 'warning', message: 'found', link: null },
        { name: 'wsl idle', status: 'check_yourself', message: 'check', link: null },
      ],
    });
    expect((await machine(created.machine.id)).unusable).toEqual([]);
    expect((await needsYou()).map((item) => item.type)).not.toContain('machine_problem');
    await warned.close();

    const tmux = {
      name: 'tmux',
      status: 'error' as const,
      message: 'tmux 3.1 is older than 3.2',
      link: null,
    };
    const broken = await connect(token);
    await broken.hello({ doctor: [tmux] });
    expect((await machine(created.machine.id)).unusable).toEqual([
      { type: 'doctor_error', check: tmux },
    ]);
    expect(await needsYou()).toContainEqual(
      expect.objectContaining({ type: 'machine_problem', checks: [tmux] }),
    );
    await broken.close();
    // The next hello whose checks pass clears it.
    await (await connect(token)).hello();
    expect((await machine(created.machine.id)).unusable).toEqual([]);
    expect((await needsYou()).map((item) => item.type)).not.toContain('machine_problem');
  });

  it('marks the machine offline after the configured silence, and heartbeats keep it online', async () => {
    await start({
      daemonSecondMs: SECOND_MS,
      settings: { heartbeatIntervalSeconds: 5, machineOfflineAfterSeconds: 15 },
    });
    const { id, daemon } = await connectedMachine();
    // 15 "seconds" of 20 ms: 300 ms. Heartbeats every 100 ms for 600 ms keep it online.
    for (let beat = 0; beat < 6; beat++) {
      daemon.heartbeat();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect((await machine(id)).state).toBe('online');
    const closed = await daemon.closed;
    expect(closed.code).toBe(DaemonCloseCode.silent);
    await eventually(async () => {
      expect((await machine(id)).state).toBe('offline');
    });
    expect((await machineEvents()).at(-1)).toEqual({
      type: 'machine.offline',
      payload: { name: 'Laptop', reason: 'silent' },
    });
  });

  it('keeps a connection its own heartbeat interval when the settings change', async () => {
    await start({
      daemonSecondMs: SECOND_MS,
      settings: { heartbeatIntervalSeconds: 20, machineOfflineAfterSeconds: 40 },
    });
    const { id, daemon } = await connectedMachine();
    // Lowered after it connected: its silence limit stays 2 × 20 "seconds" (800 ms).
    await call('PUT', '/api/settings/heartbeatIntervalSeconds', { value: 5 });
    await call('PUT', '/api/settings/machineOfflineAfterSeconds', { value: 15 });
    daemon.heartbeat();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await machine(id)).state).toBe('online');
    expect((await daemon.closed).code).toBe(DaemonCloseCode.silent);
  });

  it('closes a connection that sends no hello in time', async () => {
    await start({
      daemonSecondMs: SECOND_MS,
      settings: { heartbeatIntervalSeconds: 5, machineOfflineAfterSeconds: 15 },
    });
    const created = await createMachine();
    const daemon = await connect(await enrollToken(t.url, created.enrollment.code));
    expect((await daemon.closed).code).toBe(DaemonCloseCode.silent);
    // It never came online: no event.
    expect((await machineEvents()).map((event) => event.type)).not.toContain('machine.offline');
  });

  it('marks the machine offline as soon as the connection closes', async () => {
    await start();
    const { id, daemon } = await connectedMachine();
    await daemon.close();
    await eventually(async () => {
      expect((await machine(id)).state).toBe('offline');
    });
    expect((await machineEvents()).at(-1)).toEqual({
      type: 'machine.offline',
      payload: { name: 'Laptop', reason: 'connection_closed' },
    });
  });

  it('replaces an older connection without going offline in between', async () => {
    await start();
    const { id, token, daemon: older } = await connectedMachine();
    const newer = await connect(token);
    expect((await newer.hello()).accepted).toBe(true);
    expect((await older.closed).code).toBe(DaemonCloseCode.replaced);
    // Give the server time to handle the older close: the machine stays online.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await machine(id)).state).toBe('online');
    const types = (await machineEvents()).map((event) => event.type);
    expect(types).not.toContain('machine.offline');
    expect(types.filter((type) => type === 'machine.online')).toHaveLength(2);
    newer.heartbeat();
    expect(newer.isOpen).toBe(true);
  });

  it('closes a connection sending an invalid message or anything before hello', async () => {
    await start();
    const { token, daemon } = await connectedMachine();
    daemon.sendRaw('not json');
    expect((await daemon.closed).code).toBe(DaemonCloseCode.invalidMessage);
    const early = await connect(token);
    early.heartbeat();
    expect((await early.closed).code).toBe(DaemonCloseCode.invalidMessage);
    const unknown = await connect(token);
    unknown.send({ type: 'run.teleport', id: '3f1e0e8c-1111-4000-8000-000000000000', payload: {} });
    expect((await unknown.closed).code).toBe(DaemonCloseCode.invalidMessage);
  });

  it('marks machines left online offline when the server starts', async () => {
    await start();
    const { id } = await connectedMachine();
    // As after a crash: the machine is still recorded online.
    for (const daemon of daemons.splice(0)) await daemon.close();
    await t.db.update(schema.machines).set({ status: 'online' }).where(eq(schema.machines.id, id));
    expect(await markAllOffline(t.db)).toBe(1);
    expect((await machine(id)).state).toBe('offline');
    expect((await machineEvents()).at(-1)).toEqual({
      type: 'machine.offline',
      payload: { name: 'Laptop', reason: 'server_restarted' },
    });
  });
});

describe('owner actions on a machine', () => {
  it('disables and enables it while it stays connected', async () => {
    await start();
    const { id, daemon } = await connectedMachine();
    const disabled = Machine.parse((await call('POST', `/api/machines/${id}/disable`)).json());
    expect(disabled).toMatchObject({ state: 'disabled', online: true });
    expect(daemon.isOpen).toBe(true);
    // Twice: nothing more.
    await call('POST', `/api/machines/${id}/disable`);
    const enabled = Machine.parse((await call('POST', `/api/machines/${id}/enable`)).json());
    expect(enabled).toMatchObject({ state: 'online', disabledAt: null });
    const types = (await machineEvents()).map((event) => event.type);
    expect(types.filter((type) => type === 'machine.disabled')).toHaveLength(1);
    expect(types.at(-1)).toBe('machine.enabled');
  });

  it('refuses to revoke a machine that never enrolled, and a new code for an enrolled one', async () => {
    await start();
    const waiting = await createMachine('Waiting');
    expect(error(await call('POST', `/api/machines/${waiting.machine.id}/revoke`)).code).toBe(
      'machine_not_enrolled',
    );
    const { id } = await connectedMachine('Desktop');
    expect(error(await call('POST', `/api/machines/${id}/enrollment-code`)).code).toBe(
      'machine_already_enrolled',
    );
    expect(error(await call('GET', '/api/machines/not-an-id')).code).toBe('machine_not_found');
  });

  it('keeps where each capability comes from when the owner edits them', async () => {
    await start();
    const { id, token, daemon } = await connectedMachine();
    expect((await machine(id)).capabilities).toEqual(['git', 'node']);
    const edited = await call('PUT', `/api/machines/${id}/capabilities`, {
      capabilities: ['git', 'android-sdk'],
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(Machine.parse(edited.json())).toMatchObject({
      capabilities: ['android-sdk', 'git'],
      capabilitySources: [
        { tag: 'android-sdk', source: 'added', detected: false },
        { tag: 'git', source: 'detected', detected: true },
        { tag: 'node', source: 'removed', detected: true },
      ],
    });
    // The daemon reconnects detecting docker and android-sdk, and no longer node.
    await daemon.close();
    await (await connect(token)).hello({ capabilities: ['git', 'docker', 'android-sdk'] });
    expect(await machine(id)).toMatchObject({
      capabilities: ['android-sdk', 'docker', 'git'],
      capabilitySources: [
        { tag: 'android-sdk', source: 'added', detected: true },
        { tag: 'docker', source: 'detected', detected: true },
        { tag: 'git', source: 'detected', detected: true },
        { tag: 'node', source: 'removed', detected: false },
      ],
    });
    const invalid = await call('PUT', `/api/machines/${id}/capabilities`, {
      capabilities: ['Android SDK'],
    });
    expect(invalid.statusCode).toBe(400);
    expect(
      (await machineEvents()).filter((e) => e.type === 'machine.capabilities_changed'),
    ).toEqual([
      {
        type: 'machine.capabilities_changed',
        payload: { name: 'Laptop', capabilities: ['android-sdk', 'git'] },
      },
    ]);
  });
});

describe('"Needs you" for accounts and machines', () => {
  it('asks for an account and a machine until one is enrolled and not revoked', async () => {
    await start();
    expect(await needsYou()).toEqual([{ type: 'no_claude_account' }, { type: 'no_machine' }]);
    const account = await createAccount();
    const { enrollment, machine: created } = await createMachine('Laptop', account.id);
    expect(await needsYou()).toEqual([{ type: 'no_machine' }]);
    await enrollToken(t.url, enrollment.code);
    // Enrolled, even if offline: nothing to set up.
    expect(await needsYou()).toEqual([]);
    await call('POST', `/api/machines/${created.id}/revoke`);
    expect(await needsYou()).toEqual([{ type: 'no_machine' }]);
  });
});

import { readFile, stat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { schema } from '@orchestrator/db';
import {
  createTestHome,
  fakeExecutable,
  healthyTools,
  runDaemon,
  spawnDaemon,
  stopHomeProcesses,
  waitFor,
  type DaemonProcess,
  type TestHome,
} from '@orchestrator/daemon/testing';
import { EnrollmentResponse, Machine, NeedsYouResponse } from '@orchestrator/protocol';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SERVER_VERSION } from '../src/version.js';
import { createOwner, startTestApp, type TestApp } from './helpers.js';

// The real daemon (lot 2 step E), run from its sources as the owner types its commands, against
// the real server: enrollment, connection, reconnection after a server restart, and the refusals
// that stop it (05, sections 3.1, 3.2 and 8). Its tools are fakes (`@orchestrator/daemon/testing`).

let t: TestApp;
let cookie: string;
let home: TestHome;
const daemons: DaemonProcess[] = [];

beforeEach(async () => {
  home = await createTestHome();
  await healthyTools(home);
  t = await startTestApp({ listen: true });
  cookie = await createOwner(t.app);
});

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop('SIGKILL');
  await t.close();
  // Every process started for the test is gone before its home folder is removed.
  await stopHomeProcesses(home);
  await home.remove();
});

async function call(method: 'GET' | 'POST', url: string, payload?: object) {
  const response = await t.app.inject({ method, url, headers: { cookie }, payload });
  expect(response.statusCode, response.body).toBeLessThan(300);
  return response.json<unknown>();
}

/** Creates a machine and returns its id and one-time enrollment code. */
async function createMachine(): Promise<{ id: string; code: string }> {
  const account = (await call('POST', '/api/accounts', { label: 'Personal', plan: 'pro' })) as {
    id: string;
  };
  const created = EnrollmentResponse.parse(
    await call('POST', '/api/machines', { name: 'Laptop', accountId: account.id }),
  );
  return { id: created.machine.id, code: created.enrollment.code };
}

async function machine(id: string): Promise<Machine> {
  return Machine.parse(await call('GET', `/api/machines/${id}`));
}

function start(): DaemonProcess {
  const daemon = spawnDaemon(['start'], home.env);
  daemons.push(daemon);
  return daemon;
}

async function online(id: string, expected = true): Promise<void> {
  await waitFor(
    async () => (await machine(id)).online === expected,
    15_000,
    `online ${String(expected)}`,
  );
}

async function enrolled(): Promise<string> {
  const { id, code } = await createMachine();
  const result = await runDaemon(['enroll', t.url, code], home.env);
  expect(result.stderr).toBe('');
  expect(result.code).toBe(0);
  return id;
}

/** The raw answer of the control socket to a status request. */
function controlAnswer(): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(home.paths.controlSocket, () =>
      socket.write('{"type":"status"}\n'),
    );
    let answer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => (answer += chunk));
    socket.on('end', () => {
      resolve(answer);
    });
    socket.on('error', reject);
  });
}

describe('the real daemon against the real server', { timeout: 60_000 }, () => {
  it('enrolls, connects with its checks, and stops for good when revoked', async () => {
    const { id, code } = await createMachine();
    const enrollment = await runDaemon(['enroll', t.url, code], home.env);
    expect(enrollment.code).toBe(0);
    expect(enrollment.stdout).toContain('enrolled as the machine "Laptop"');
    const config = JSON.parse(await readFile(home.paths.config, 'utf8')) as {
      machineToken: string;
    };
    expect(config.machineToken).toMatch(/^omt_/);
    expect((await stat(home.paths.config)).mode & 0o777).toBe(0o600);
    expect((await stat(home.paths.home)).mode & 0o777).toBe(0o700);

    const daemon = start();
    await online(id);
    const connected = await machine(id);
    expect(connected).toMatchObject({
      daemonVersion: SERVER_VERSION,
      claudeCodeVersion: '2.1.282',
      claudeCodeSupport: 'supported',
    });
    expect(connected.capabilities).toEqual(expect.arrayContaining(['git', 'node']));
    expect(connected.doctor).toContainEqual({
      name: 'Git',
      status: 'ok',
      message: 'Git 2.53.0',
      link: null,
    });

    const status = await runDaemon(['status'], home.env);
    expect(status.code).toBe(0);
    expect(status.stdout).toMatch(
      /running in a terminal[\s\S]*Machine: Laptop[\s\S]*Connection: connected/,
    );
    // Read-only and without secrets: agents run under the same user.
    expect(await controlAnswer()).not.toContain(config.machineToken);

    const second = await runDaemon(['start'], home.env);
    expect(second.code).toBe(78);
    expect(second.stderr).toMatch(/already running in a terminal/);

    await call('POST', `/api/machines/${id}/revoke`);
    expect(await daemon.exited).toBe(78);
    expect(daemon.stderr()).toMatch(/revoked in the Orchestrator.*New enrollment code/);
    expect(JSON.parse(await readFile(home.paths.lastStop, 'utf8'))).toMatchObject({
      reason: 'revoked',
    });
    await expect(stat(home.paths.controlSocket)).rejects.toThrow();

    const after = await runDaemon(['status'], home.env);
    expect(after.code).toBe(1);
    expect(after.stdout).toMatch(
      /No daemon is running\.\nLast stop \(.*\): This machine was revoked/,
    );
    expect((await runDaemon(['doctor'], home.env)).stdout).toMatch(
      /Last stop \(.*\): This machine was revoked/,
    );
  });

  it('reconnects after a server restart', async () => {
    const id = await enrolled();
    start();
    await online(id);
    await t.restart();
    await online(id);
    const events = await t.db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.entityId, id), eq(schema.events.type, 'machine.online')));
    expect(events).toHaveLength(2);
    expect((await runDaemon(['status'], home.env)).stdout).toContain('Connection: connected');
  });

  it('stops when the server no longer knows its key', async () => {
    const id = await enrolled();
    await call('POST', `/api/machines/${id}/revoke`);
    await call('POST', `/api/machines/${id}/enrollment-code`);
    const daemon = start();
    expect(await daemon.exited).toBe(78);
    expect(daemon.stderr()).toMatch(/does not know this machine's key/);
    expect(JSON.parse(await readFile(home.paths.lastStop, 'utf8'))).toMatchObject({
      reason: 'unknown_token',
    });
  });

  it('stops on a signal, records it, and a new enrollment clears the last stop', async () => {
    const id = await enrolled();
    const daemon = start();
    await online(id);
    daemon.child.kill('SIGTERM');
    expect(await daemon.exited).toBe(0);
    await online(id, false);
    expect(JSON.parse(await readFile(home.paths.lastStop, 'utf8'))).toMatchObject({
      reason: 'stopped',
    });
    await expect(stat(home.paths.controlSocket)).rejects.toThrow();

    // Starting again welcomes the daemon, which makes the last stop history.
    start();
    await online(id);
    await waitFor(async () => {
      try {
        await stat(home.paths.lastStop);
        return false;
      } catch {
        return true;
      }
    });
  });
  it('as the service without process scopes: online, unusable, with the reason in Needs you', async () => {
    // A systemd that refuses every scope (05, section 2).
    await fakeExecutable(home.bin, 'systemctl', 'exit 0');
    await fakeExecutable(
      home.bin,
      'systemd-run',
      "printf '%s\\n' 'Failed to connect to bus: No medium found' >&2\nexit 1",
    );
    const id = await enrolled();
    const daemon = spawnDaemon(['start', '--service'], home.env);
    daemons.push(daemon);
    await online(id);
    const connected = await machine(id);
    const check = connected.doctor.find((each) => each.name === 'Process scopes');
    expect(check).toMatchObject({ status: 'error', link: `${t.url}/help/machines#process-scopes` });
    expect(check?.message).toContain('Failed to connect to bus: No medium found');
    expect(connected.unusable).toEqual([{ type: 'doctor_error', check }]);
    const items = NeedsYouResponse.parse(await call('GET', '/api/needs-you')).items;
    expect(items).toContainEqual(
      expect.objectContaining({ type: 'machine_problem', checks: [check] }),
    );
  });
});

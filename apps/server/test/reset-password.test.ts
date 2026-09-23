import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { schema } from '@orchestrator/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OWNER, TEST_SECRET_KEY, createOwner, startTestApp, type TestApp } from './helpers.js';

const serverDir = fileURLToPath(new URL('..', import.meta.url));
const NEW_PASSWORD = 'a brand new passphrase';

let t: TestApp;

beforeEach(async () => {
  t = await startTestApp();
});

afterEach(async () => {
  await t.close();
});

/** Runs `orchestrator <args>` from the sources, typing `input` on its standard input. */
function orchestrator(args: string[], input: string) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(
      process.execPath,
      ['--conditions=source', '--import', 'tsx', 'src/cli.ts', ...args],
      {
        cwd: serverDir,
        env: {
          PATH: process.env.PATH,
          DATABASE_URL: t.database.url,
          ORCHESTRATOR_SECRET_KEY: TEST_SECRET_KEY,
        },
      },
      (error, stdout, stderr) => {
        resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr });
      },
    );
    child.stdin?.end(input);
  });
}

async function login(password: string) {
  return t.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: OWNER.username, password },
  });
}

describe('orchestrator reset-password', () => {
  it('changes the password, logs out every session and writes an event', async () => {
    const cookie = await createOwner(t.app);

    const result = await orchestrator(['reset-password'], `${NEW_PASSWORD}\n${NEW_PASSWORD}\n`);

    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Password changed for ${OWNER.username}`);
    expect(result.stdout).not.toContain(NEW_PASSWORD);
    expect((await login(OWNER.password)).statusCode).toBe(401);
    expect((await login(NEW_PASSWORD)).statusCode).toBe(200);
    const session = await t.app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie },
    });
    expect(session.statusCode).toBe(401);
    const events = await t.db.select().from(schema.events);
    expect(events.find((event) => event.type === 'owner.password_reset')).toMatchObject({
      actor: 'cli',
      payload: { revokedSessions: 1 },
    });
    expect(JSON.stringify(events)).not.toContain(NEW_PASSWORD);
  });

  it('lifts a login delay so the owner can log in at once', async () => {
    await createOwner(t.app);
    for (let attempt = 0; attempt < 5; attempt++) await login('wrong password!');
    expect((await login(OWNER.password)).statusCode).toBe(429);

    const result = await orchestrator(['reset-password'], `${NEW_PASSWORD}\n${NEW_PASSWORD}\n`);

    expect(result.code).toBe(0);
    expect((await login(NEW_PASSWORD)).statusCode).toBe(200);
  });

  it('refuses a password shorter than 12 characters and keeps the old one', async () => {
    await createOwner(t.app);
    const result = await orchestrator(['reset-password'], 'elevenchars\nelevenchars\n');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('The password must have at least 12 characters.');
    expect((await login(OWNER.password)).statusCode).toBe(200);
  });

  it('refuses two different passwords', async () => {
    await createOwner(t.app);
    const result = await orchestrator(
      ['reset-password'],
      `${NEW_PASSWORD}\nsomething else entirely\n`,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('The two passwords are different.');
    expect((await login(OWNER.password)).statusCode).toBe(200);
  });

  it('explains that the owner must first be created', async () => {
    const result = await orchestrator(['reset-password'], `${NEW_PASSWORD}\n${NEW_PASSWORD}\n`);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('There is no owner account yet');
  });

  it('shows the usage for an unknown command, without asking anything', async () => {
    const result = await orchestrator(['reset-pasword'], '');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Usage: orchestrator reset-password');
  });
});

import { schema } from '@orchestrator/db';
import {
  type ApiError,
  CreateOwnerRequest,
  LoginRequest,
  type SessionResponse,
  type SetupStateResponse,
} from '@orchestrator/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Database } from '../database.js';
import { recordEvent } from '../events.js';
import { HttpError, parseInput } from '../http.js';
import type { Settings } from '../settings.js';
import { hashPassword, unknownUserHash, verifyPassword } from './password.js';
import { LoginThrottle } from './throttle.js';
import {
  SESSION_COOKIE,
  createSession,
  findSession,
  revokeSession,
  type ActiveSession,
  type NewSession,
} from './sessions.js';

export interface AuthOptions {
  db: Database;
  settings: Settings;
  /**
   * Cookies get the Secure flag only when PUBLIC_URL is HTTPS: browsers never send a Secure
   * cookie over plain HTTP, so login would silently fail on a LAN address.
   */
  secureCookies: boolean;
  /** Clock of the login throttle; tests replace it. */
  now?: () => Date;
}

/** The logged-in session, or a 401 refusal. Every route except setup and login calls it. */
export async function requireSession(
  db: Database,
  request: FastifyRequest,
): Promise<ActiveSession> {
  const token = request.cookies[SESSION_COOKIE];
  const session = token === undefined ? null : await findSession(db, token);
  if (!session) throw new HttpError(401, 'not_authenticated', 'Log in first');
  return session;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  { db, settings, secureCookies, now }: AuthOptions,
) {
  const throttle = new LoginThrottle(db, settings, now);

  async function ownerUsername(): Promise<string | null> {
    const [owner] = await db.select({ username: schema.owner.username }).from(schema.owner);
    return owner?.username ?? null;
  }

  function startSession(reply: FastifyReply, session: NewSession, username: string) {
    reply.setCookie(SESSION_COOKIE, session.token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: secureCookies,
      path: '/',
      expires: session.expiresAt,
    });
    return { username, expiresAt: session.expiresAt.toISOString() } satisfies SessionResponse;
  }

  app.get('/api/setup', async () => {
    const [owner] = await db.select({ id: schema.owner.id }).from(schema.owner);
    const [github] = await db
      .select({ id: schema.githubConnection.id })
      .from(schema.githubConnection);
    return {
      ownerCreated: owner !== undefined,
      githubConnected: github !== undefined,
    } satisfies SetupStateResponse;
  });

  // Wizard step 1 (02, section 3). The single-row constraint refuses a second owner, even when
  // two requests race.
  app.post('/api/setup/owner', async (request, reply) => {
    const input = parseInput(CreateOwnerRequest, request.body);
    if ((await ownerUsername()) !== null) {
      throw new HttpError(409, 'owner_exists', 'The owner account already exists');
    }
    const passwordHash = await hashPassword(input.password);
    const session = await db.transaction(async (tx) => {
      const created = await tx
        .insert(schema.owner)
        .values({ username: input.username, passwordHash })
        .onConflictDoNothing()
        .returning({ id: schema.owner.id });
      if (created.length === 0) return null;
      await recordEvent(tx, {
        actor: 'owner',
        entityType: 'owner',
        entityId: '1',
        type: 'owner.created',
        payload: { username: input.username },
      });
      return createSession(tx, settings.sessionLifetimeDays);
    });
    if (!session) throw new HttpError(409, 'owner_exists', 'The owner account already exists');
    request.log.info('owner account created');
    return reply.code(201).send(startSession(reply, session, input.username));
  });

  app.post('/api/auth/login', async (request, reply) => {
    const input = parseInput(LoginRequest, request.body);
    const attempt = { username: input.username, address: request.ip };
    const wait = await throttle.waitSeconds(attempt);
    if (wait > 0) {
      request.log.warn({ wait }, 'login refused: too many failed attempts');
      return reply
        .code(429)
        .header('retry-after', String(wait))
        .send({
          error: {
            code: 'too_many_attempts',
            message: `Too many failed logins; try again in ${String(wait)} seconds`,
            retryAfterSeconds: wait,
          },
        } satisfies ApiError);
    }
    const [owner] = await db.select().from(schema.owner);
    const matches = owner?.username === input.username;
    // Always verify a hash, so the answer takes as long for an unknown username.
    const valid = await verifyPassword(
      matches ? owner.passwordHash : unknownUserHash,
      input.password,
    );
    if (!owner || !matches || !valid) {
      request.log.warn('login refused');
      await throttle.recordFailure(attempt);
      throw new HttpError(401, 'invalid_credentials', 'Wrong username or password');
    }
    await throttle.clear(attempt);
    const session = await db.transaction((tx) => createSession(tx, settings.sessionLifetimeDays));
    return startSession(reply, session, owner.username);
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    const session = token === undefined ? null : await findSession(db, token);
    if (session) await db.transaction((tx) => revokeSession(tx, session.id));
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.code(204).send();
  });

  app.get('/api/auth/session', async (request) => {
    const session = await requireSession(db, request);
    const username = await ownerUsername();
    if (username === null) throw new HttpError(401, 'not_authenticated', 'Log in first');
    return { username, expiresAt: session.expiresAt.toISOString() } satisfies SessionResponse;
  });
}

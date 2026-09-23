import { createHash, randomBytes } from 'node:crypto';
import { schema } from '@orchestrator/db';
import { and, eq, gt, lte } from 'drizzle-orm';
import type { Executor } from '../database.js';
import { recordEvent } from '../events.js';

/** Name of the HTTP-only session cookie (09, section 5; ADR 0015). */
export const SESSION_COOKIE = 'orchestrator_session';

export interface NewSession {
  /** Sent to the browser in the cookie only; the database keeps its hash. */
  token: string;
  expiresAt: Date;
}

export interface ActiveSession {
  id: string;
  expiresAt: Date;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Creates a login session, deleting the expired ones on the way. */
export async function createSession(db: Executor, lifetimeDays: number): Promise<NewSession> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + lifetimeDays * 24 * 60 * 60 * 1000);
  await db.delete(schema.sessions).where(lte(schema.sessions.expiresAt, new Date()));
  const [session] = await db
    .insert(schema.sessions)
    .values({ tokenHash: hashToken(token), expiresAt })
    .returning({ id: schema.sessions.id });
  await recordEvent(db, {
    actor: 'owner',
    entityType: 'session',
    entityId: session?.id,
    type: 'session.created',
    payload: { expiresAt: expiresAt.toISOString() },
  });
  return { token, expiresAt };
}

/** The unexpired session matching a cookie value, if any. */
export async function findSession(db: Executor, token: string): Promise<ActiveSession | null> {
  const [session] = await db
    .select({ id: schema.sessions.id, expiresAt: schema.sessions.expiresAt })
    .from(schema.sessions)
    .where(
      and(
        eq(schema.sessions.tokenHash, hashToken(token)),
        gt(schema.sessions.expiresAt, new Date()),
      ),
    );
  return session ?? null;
}

export async function revokeSession(db: Executor, id: string): Promise<void> {
  await db.delete(schema.sessions).where(eq(schema.sessions.id, id));
  await recordEvent(db, {
    actor: 'owner',
    entityType: 'session',
    entityId: id,
    type: 'session.revoked',
    payload: { reason: 'logout' },
  });
}

/** Revokes every session; returns how many were active or expired. */
export async function revokeAllSessions(db: Executor): Promise<number> {
  const deleted = await db.delete(schema.sessions).returning({ id: schema.sessions.id });
  return deleted.length;
}

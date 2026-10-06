import { schema } from '@orchestrator/db';
import { GitHubProblem, PermissionCheck, type GitHubStatusResponse } from '@orchestrator/protocol';
import { eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Database, Executor } from '../database.js';
import { recordEvent } from '../events.js';
import { SecretUnreadableError, loadSecret, storeSecret, type SecretKey } from '../secrets.js';
import { resolveSettings } from '../settings/store.js';
import {
  acceptedPermissions,
  createGitHubClient,
  describeRequest,
  isNotAccessible,
  type GitHubClient,
  type GitHubLog,
  type GitHubRequest,
  type GitHubResponse,
} from './client.js';

/** Name of the GitHub token in the `secrets` table. */
export const GITHUB_TOKEN_SECRET = 'github_token';

const Refusal = z.object({
  permissions: z.array(z.string()),
  request: z.string(),
  at: z.string(),
});
type Refusal = z.infer<typeof Refusal>;

const entity = { entityType: 'github_connection', entityId: '1' } as const;

function today(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / (24 * 60 * 60 * 1000));
}

/** True when the date is before today (UTC): the token would already have expired. */
export function isPast(date: string, now = new Date()): boolean {
  return date < today(now);
}

/** The connection as shown by the wizard, Settings and "Needs you". Never includes the token. */
export async function loadStatus(db: Executor, now = new Date()): Promise<GitHubStatusResponse> {
  const [row] = await db.select().from(schema.githubConnection);
  if (!row) return { connected: false };
  const permissions = z.array(PermissionCheck).parse(row.permissions);
  const refusals = z.array(Refusal).parse(row.refusals);

  const problems: GitHubProblem[] = [];
  if (row.unreadableSince) {
    problems.push({ type: 'token_unreadable', since: row.unreadableSince.toISOString() });
  }
  if (row.invalidSince) {
    problems.push({ type: 'token_invalid', since: row.invalidSince.toISOString() });
  }
  if (row.expiresOn !== null) {
    const daysLeft = daysBetween(today(now), row.expiresOn);
    const { githubTokenExpiryWarningDays } = await resolveSettings(db, [
      'githubTokenExpiryWarningDays',
    ]);
    if (daysLeft < 0) problems.push({ type: 'token_expired', expiresOn: row.expiresOn });
    else if (daysLeft <= githubTokenExpiryWarningDays) {
      problems.push({ type: 'token_expiring', expiresOn: row.expiresOn });
    }
  }
  for (const check of permissions) {
    if (check.result === 'missing') {
      problems.push({
        type: 'permission_missing',
        permission: check.permission,
        access: check.access,
      });
    }
  }
  for (const refusal of refusals) problems.push({ type: 'permission_refused', ...refusal });

  return {
    connected: true,
    account: row.account,
    expiresOn: row.expiresOn,
    savedAt: row.savedAt.toISOString(),
    checkedAt: row.checkedAt.toISOString(),
    permissions,
    problems,
  };
}

/** Stores a new token (encrypted) with its check result; clears the previous token's problems. */
export async function saveToken(
  db: Database,
  key: SecretKey,
  input: {
    token: string;
    expiresOn: string | null;
    account: string;
    accountId: number;
    permissions: PermissionCheck[];
  },
): Promise<void> {
  const now = new Date();
  const values = {
    account: input.account,
    accountId: input.accountId,
    expiresOn: input.expiresOn,
    savedAt: now,
    checkedAt: now,
    permissions: input.permissions,
    unreadableSince: null,
    invalidSince: null,
    refusals: [],
  };
  await db.transaction(async (tx) => {
    await storeSecret(tx, key, GITHUB_TOKEN_SECRET, input.token);
    await tx
      .insert(schema.githubConnection)
      .values(values)
      .onConflictDoUpdate({ target: schema.githubConnection.id, set: values });
    await recordEvent(tx, {
      actor: 'owner',
      ...entity,
      type: 'github.token_saved',
      payload: { account: input.account, expiresOn: input.expiresOn },
    });
    await recordEvent(tx, {
      actor: 'owner',
      ...entity,
      type: 'github.token_checked',
      payload: { permissions: summarize(input.permissions) },
    });
  });
}

/**
 * Stores the result of re-checking the saved token. A valid token clears earlier refusals. The
 * account id is stored here too, for a token saved before 0.3.0 (02, section 3.2).
 */
export async function saveCheck(
  db: Database,
  input: { account: string; accountId: number; permissions: PermissionCheck[] },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(schema.githubConnection)
      .set({
        account: input.account,
        accountId: input.accountId,
        checkedAt: new Date(),
        permissions: input.permissions,
        invalidSince: null,
        refusals: [],
      })
      .where(eq(schema.githubConnection.id, 1));
    await recordEvent(tx, {
      actor: 'owner',
      ...entity,
      type: 'github.token_checked',
      payload: { permissions: summarize(input.permissions) },
    });
  });
}

function summarize(permissions: PermissionCheck[]): Record<string, string> {
  return Object.fromEntries(permissions.map((check) => [check.permission, check.result]));
}

/**
 * GitHub rejected the stored token (HTTP 401): "Needs you" shows it until a new token or a
 * successful check. Does nothing when the token is already marked invalid.
 */
export async function markTokenInvalid(
  db: Database,
  actor: 'owner' | 'system',
  request: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const updated = await tx
      .update(schema.githubConnection)
      .set({ invalidSince: new Date() })
      .where(isNull(schema.githubConnection.invalidSince))
      .returning({ invalidSince: schema.githubConnection.invalidSince });
    if (updated.length === 0) return;
    await recordEvent(tx, {
      actor,
      ...entity,
      type: 'github.token_rejected',
      payload: { request },
    });
  });
}

/**
 * The saved token cannot be decrypted: ORCHESTRATOR_SECRET_KEY was lost or changed (ADR 0016).
 * "Needs you" asks the owner to enter the token again. Does nothing when already recorded.
 */
export async function markTokenUnreadable(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    const updated = await tx
      .update(schema.githubConnection)
      .set({ unreadableSince: new Date() })
      .where(isNull(schema.githubConnection.unreadableSince))
      .returning({ id: schema.githubConnection.id });
    if (updated.length === 0) return;
    await recordEvent(tx, { actor: 'system', ...entity, type: 'github.token_unreadable' });
  });
}

/**
 * Reads the saved token. When it cannot be decrypted, records the problem for "Needs you" and
 * throws `SecretUnreadableError`; the server keeps running.
 */
export async function loadToken(db: Database, key: SecretKey): Promise<string | null> {
  try {
    return await loadSecret(db, key, GITHUB_TOKEN_SECRET);
  } catch (error) {
    if (error instanceof SecretUnreadableError) await markTokenUnreadable(db);
    throw error;
  }
}

/** Run at start: records an unreadable token at once instead of at its first use. */
export async function detectUnreadableToken(
  db: Database,
  key: SecretKey,
  log: { warn: (object: object, message: string) => void },
): Promise<void> {
  try {
    await loadToken(db, key);
  } catch (error) {
    if (!(error instanceof SecretUnreadableError)) throw error;
    log.warn(
      { err: error },
      'saved GitHub token cannot be decrypted: ORCHESTRATOR_SECRET_KEY changed; the owner must enter the token again',
    );
  }
}

async function recordRefusal(db: Database, refusal: Refusal): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ refusals: schema.githubConnection.refusals })
      .from(schema.githubConnection)
      .for('update');
    if (!row) return;
    const refusals = z.array(Refusal).parse(row.refusals);
    const known = refusals.some(
      (existing) =>
        existing.request === refusal.request &&
        existing.permissions.join() === refusal.permissions.join(),
    );
    if (known) return;
    await tx
      .update(schema.githubConnection)
      .set({ refusals: [...refusals, refusal] })
      .where(eq(schema.githubConnection.id, 1));
    await recordEvent(tx, {
      actor: 'system',
      ...entity,
      type: 'github.permission_refused',
      payload: { permissions: refusal.permissions, request: refusal.request },
    });
  });
}

export interface StoredTokenOptions {
  db: Database;
  key: SecretKey;
  apiUrl: string;
  /** Where answers the Orchestrator cannot read are logged (`GitHubClient.unreadable`). */
  log?: GitHubLog;
}

/**
 * Client for every GitHub request made with the saved token during normal operation. It records
 * refusals (ADR 0022): a 401 marks the token invalid, a "not accessible" 403 records the
 * permissions GitHub names. Null when no token is saved; throws `SecretUnreadableError` (after
 * recording the problem) when the token cannot be decrypted.
 */
export async function storedTokenClient(options: StoredTokenOptions): Promise<GitHubClient | null> {
  const token = await loadToken(options.db, options.key);
  if (token === null) return null;
  const { githubRequestTimeoutSeconds } = await resolveSettings(options.db, [
    'githubRequestTimeoutSeconds',
  ]);
  return createGitHubClient({
    apiUrl: options.apiUrl,
    token,
    timeoutSeconds: githubRequestTimeoutSeconds,
    log: options.log,
    onResponse: async (request: GitHubRequest, response: GitHubResponse) => {
      if (response.status === 401) {
        await markTokenInvalid(options.db, 'system', describeRequest(request));
      } else if (isNotAccessible(response)) {
        await recordRefusal(options.db, {
          permissions: acceptedPermissions(response.headers),
          request: describeRequest(request),
          at: new Date().toISOString(),
        });
      }
    },
  });
}

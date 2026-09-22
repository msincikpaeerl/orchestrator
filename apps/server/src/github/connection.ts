import { schema } from '@orchestrator/db';
import { GitHubProblem, PermissionCheck, type GitHubStatusResponse } from '@orchestrator/protocol';
import { eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Database, Executor } from '../database.js';
import { recordEvent } from '../events.js';
import { loadSecret, storeSecret, type SecretKey } from '../secrets.js';
import type { Settings } from '../settings.js';
import {
  acceptedPermissions,
  createGitHubClient,
  isNotAccessible,
  type GitHubClient,
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
export async function loadStatus(
  db: Executor,
  settings: Settings,
  now = new Date(),
): Promise<GitHubStatusResponse> {
  const [row] = await db.select().from(schema.githubConnection);
  if (!row) return { connected: false };
  const permissions = z.array(PermissionCheck).parse(row.permissions);
  const refusals = z.array(Refusal).parse(row.refusals);

  const problems: GitHubProblem[] = [];
  if (row.invalidSince) {
    problems.push({ type: 'token_invalid', since: row.invalidSince.toISOString() });
  }
  if (row.expiresOn !== null) {
    const daysLeft = daysBetween(today(now), row.expiresOn);
    if (daysLeft < 0) problems.push({ type: 'token_expired', expiresOn: row.expiresOn });
    else if (daysLeft <= settings.githubTokenExpiryWarningDays) {
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
    permissions: PermissionCheck[];
  },
): Promise<void> {
  const now = new Date();
  const values = {
    account: input.account,
    expiresOn: input.expiresOn,
    savedAt: now,
    checkedAt: now,
    permissions: input.permissions,
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

/** Stores the result of re-checking the saved token. A valid token clears earlier refusals. */
export async function saveCheck(
  db: Database,
  input: { account: string; permissions: PermissionCheck[] },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(schema.githubConnection)
      .set({
        account: input.account,
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

function describe(request: GitHubRequest): string {
  return `${request.method} ${request.path.split('?')[0] ?? request.path}`;
}

export interface StoredTokenOptions {
  db: Database;
  key: SecretKey;
  apiUrl: string;
  settings: Settings;
}

/**
 * Client for every GitHub request made with the saved token during normal operation. It records
 * refusals (ADR 0017): a 401 marks the token invalid, a "not accessible" 403 records the
 * permissions GitHub names. Null when no token is saved.
 */
export async function storedTokenClient(options: StoredTokenOptions): Promise<GitHubClient | null> {
  const token = await loadSecret(options.db, options.key, GITHUB_TOKEN_SECRET);
  if (token === null) return null;
  return createGitHubClient({
    apiUrl: options.apiUrl,
    token,
    timeoutSeconds: options.settings.githubRequestTimeoutSeconds,
    onResponse: async (request: GitHubRequest, response: GitHubResponse) => {
      if (response.status === 401) {
        await markTokenInvalid(options.db, 'system', describe(request));
      } else if (isNotAccessible(response)) {
        await recordRefusal(options.db, {
          permissions: acceptedPermissions(response.headers),
          request: describe(request),
          at: new Date().toISOString(),
        });
      }
    },
  });
}

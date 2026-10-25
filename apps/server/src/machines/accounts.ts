import { schema } from '@orchestrator/db';
import {
  ACCOUNT_DAYS_SHOWN,
  ACCOUNT_LIMITS_SHOWN,
  ACCOUNT_BUSY_RUN_STATUSES,
  CreateAccountRequest,
  DailyBudget,
  EventPayloads,
  Schedule,
  UpdateAccountRequest,
  type AccountDetailResponse,
  type AccountListResponse,
  type ClaudeAccount,
  type DayUsage,
} from '@orchestrator/protocol';
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireSession } from '../auth/routes.js';
import type { Database, Executor } from '../database.js';
import { recordEvent } from '../events.js';
import { HttpError, parseInput, uniqueViolation } from '../http.js';
import { isLimited } from '../runs/model.js';
import { readTimeZone } from '../settings/time-zone.js';
import { accountToday, accountUsage, todayKey } from './account-day.js';
import { accountNotFound, toAccount, type AccountRow } from './model.js';
import { addDays, dateText, dayBounds } from './schedule.js';

const labelTaken = () =>
  new HttpError(409, 'account_label_taken', 'Another Claude account already has this label');

/** Runs `action`, turning a duplicate label into `account_label_taken`. */
async function uniqueLabel<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (uniqueViolation(error) === 'claude_accounts_label') throw labelTaken();
    throw error;
  }
}

/** The accounts as the screens show them, with their day so far (07, section 7). */
export async function accountsWithToday(
  db: Executor,
  rows: readonly AccountRow[],
  now: Date,
): Promise<{ accounts: ClaudeAccount[]; timeZone: AccountListResponse['timeZone'] }> {
  const timeZone = await readTimeZone(db);
  const usage = await accountUsage(
    db,
    rows.map((row) => row.id),
    timeZone.timeZone,
    now,
  );
  const today = todayKey(timeZone.timeZone, now);
  return {
    timeZone,
    accounts: rows.map((row) =>
      toAccount(row, accountToday(row, usage.get(row.id)?.get(today), timeZone.timeZone, now), now),
    ),
  };
}

/** Every account, by label. */
export function accountRows(db: Executor): Promise<AccountRow[]> {
  return db
    .select()
    .from(schema.claudeAccounts)
    .orderBy(asc(sql`lower(${schema.claudeAccounts.label})`));
}

const UPDATED_FIELDS = ['label', 'plan', 'maxConcurrentRuns', 'schedule', 'dailyBudget'] as const;

/**
 * Claude accounts (02, section 9.1): a label, a plan and the maximum concurrent runs (lot 2),
 * the schedule windows, the daily budget and **Stop new runs** and **Resume** (lot 4 step C). A
 * usage limit changes the state too (lot 2 step J), never the owner here.
 */
export function registerAccountRoutes(
  app: FastifyInstance,
  {
    db,
    now: clock = () => new Date(),
    resumed,
  }: {
    db: Database;
    now?: () => Date;
    /** After **Resume**: the automatic merges it held are tried (lot 5 step 5bis B, answer 7). */
    resumed?: () => void;
  },
) {
  /** The account locked for the transaction. */
  async function lockedAccount(tx: Executor, id: string): Promise<AccountRow> {
    const [row] = await tx
      .select()
      .from(schema.claudeAccounts)
      .where(eq(schema.claudeAccounts.id, id))
      .for('update');
    if (!row) throw accountNotFound();
    return row;
  }

  async function shown(row: AccountRow): Promise<ClaudeAccount> {
    const { accounts } = await accountsWithToday(db, [row], clock());
    const [account] = accounts;
    if (!account) throw accountNotFound();
    return account;
  }

  const accountId = (value: string) => {
    const id = z.uuid().safeParse(value);
    if (!id.success) throw accountNotFound();
    return id.data;
  };

  app.get('/api/accounts', async (request) => {
    await requireSession(db, request);
    return (await accountsWithToday(
      db,
      await accountRows(db),
      clock(),
    )) satisfies AccountListResponse;
  });

  app.get<{ Params: { id: string } }>('/api/accounts/:id', async (request) => {
    await requireSession(db, request);
    const id = accountId(request.params.id);
    const [row] = await db
      .select()
      .from(schema.claudeAccounts)
      .where(eq(schema.claudeAccounts.id, id));
    if (!row) throw accountNotFound();
    const now = clock();
    const timeZone = await readTimeZone(db);
    const usage =
      (await accountUsage(db, [row.id], timeZone.timeZone, now, ACCOUNT_DAYS_SHOWN)).get(row.id) ??
      new Map<string, DayUsage>();
    const today = dayBounds(now, timeZone.timeZone).date;
    const days = Array.from({ length: ACCOUNT_DAYS_SHOWN }, (_, index) => {
      const date = dateText(addDays(today, -index));
      return {
        date,
        ...(usage.get(date) ?? {
          runs: 0,
          workingMs: 0,
          estimatedUsageUsd: 0,
          runsWithoutEstimate: 0,
        }),
      };
    });
    const where = and(
      eq(schema.events.entityType, 'claude_account'),
      eq(schema.events.entityId, row.id),
      eq(schema.events.type, 'account.limited'),
    );
    const limitRows = await db
      .select({ at: schema.events.createdAt, payload: schema.events.payload })
      .from(schema.events)
      .where(where)
      .orderBy(desc(schema.events.createdAt), desc(schema.events.id))
      .limit(ACCOUNT_LIMITS_SHOWN);
    const [total] = await db.select({ count: count() }).from(schema.events).where(where);
    const todayUsage = usage.get(dateText(today));
    return {
      account: toAccount(row, accountToday(row, todayUsage, timeZone.timeZone, now), now),
      timeZone,
      days: days.map((day) => ({
        ...day,
        estimatedUsageUsd: Math.round(day.estimatedUsageUsd * 10_000) / 10_000,
      })),
      limits: limitRows.map((limit) => {
        const payload = EventPayloads['account.limited'].parse(limit.payload);
        return { at: limit.at.toISOString(), until: payload.until, source: payload.source };
      }),
      limitCount: total?.count ?? 0,
    } satisfies AccountDetailResponse;
  });

  app.post('/api/accounts', async (request, reply) => {
    await requireSession(db, request);
    const input = parseInput(CreateAccountRequest, request.body);
    const row = await uniqueLabel(() =>
      db.transaction(async (tx) => {
        const [inserted] = await tx.insert(schema.claudeAccounts).values(input).returning();
        if (!inserted) throw new Error('account not inserted');
        await recordEvent(tx, {
          actor: 'owner',
          entityType: 'claude_account',
          entityId: inserted.id,
          type: 'account.created',
          payload: {
            label: inserted.label,
            plan: inserted.plan,
            maxConcurrentRuns: inserted.maxConcurrentRuns,
          },
        });
        return inserted;
      }),
    );
    request.log.info({ account: row.id }, 'Claude account created');
    return reply.code(201).send(await shown(row));
  });

  app.patch<{ Params: { id: string } }>('/api/accounts/:id', async (request) => {
    await requireSession(db, request);
    const id = accountId(request.params.id);
    const input = parseInput(UpdateAccountRequest, request.body);
    const row = await uniqueLabel(() =>
      db.transaction(async (tx): Promise<AccountRow> => {
        const current = await lockedAccount(tx, id);
        // The stored windows and budget come back from jsonb with their keys sorted.
        const shape = (field: (typeof UPDATED_FIELDS)[number], value: unknown) =>
          field === 'schedule'
            ? Schedule.parse(value)
            : field === 'dailyBudget'
              ? DailyBudget.parse(value)
              : value;
        const same = (field: (typeof UPDATED_FIELDS)[number]) =>
          JSON.stringify(shape(field, input[field])) ===
          JSON.stringify(shape(field, current[field]));
        const fields = UPDATED_FIELDS.filter((field) => input[field] !== undefined && !same(field));
        if (fields.length === 0) return current;
        const [updated] = await tx
          .update(schema.claudeAccounts)
          .set({ ...input, updatedAt: clock() })
          .where(eq(schema.claudeAccounts.id, current.id))
          .returning();
        if (!updated) throw accountNotFound();
        const copied = (field: (typeof UPDATED_FIELDS)[number]) =>
          fields.includes(field) ? { [field]: updated[field] } : {};
        await recordEvent(tx, {
          actor: 'owner',
          entityType: 'claude_account',
          entityId: updated.id,
          type: 'account.updated',
          payload: {
            label: updated.label,
            fields,
            ...(fields.includes('label') ? { previousLabel: current.label } : {}),
            ...copied('plan'),
            ...copied('maxConcurrentRuns'),
            ...copied('schedule'),
            ...copied('dailyBudget'),
          },
        });
        return updated;
      }),
    );
    request.log.info({ account: row.id }, 'Claude account edited');
    return shown(row);
  });

  // **Stop new runs** and **Resume** (07, section 5.5; owner's answer 7, lot 4 step A): the
  // active runs finish; Run now and Resume of a paused run are refused until Resume.
  app.post<{ Params: { id: string } }>('/api/accounts/:id/stop-new-runs', async (request) => {
    await requireSession(db, request);
    const id = accountId(request.params.id);
    const row = await db.transaction(async (tx) => {
      const current = await lockedAccount(tx, id);
      if (current.state === 'paused_manual') return current;
      const now = clock();
      // A limit still running is kept for Resume; one passed is not.
      const keep = isLimited(current, now);
      const [updated] = await tx
        .update(schema.claudeAccounts)
        .set({
          state: 'paused_manual',
          limitedUntil: keep ? current.limitedUntil : null,
          limitedUntilEstimated: keep && current.limitedUntilEstimated,
          updatedAt: now,
        })
        .where(eq(schema.claudeAccounts.id, current.id))
        .returning();
      if (!updated) throw accountNotFound();
      const [active] = await tx
        .select({ count: count() })
        .from(schema.runs)
        .where(
          and(
            eq(schema.runs.accountId, current.id),
            inArray(schema.runs.status, [...ACCOUNT_BUSY_RUN_STATUSES]),
          ),
        );
      await recordEvent(tx, {
        actor: 'owner',
        entityType: 'claude_account',
        entityId: current.id,
        type: 'account.paused',
        payload: { label: current.label, activeRuns: active?.count ?? 0 },
        at: now,
      });
      return updated;
    });
    request.log.info({ account: row.id }, 'new runs stopped on the Claude account');
    return shown(row);
  });

  app.post<{ Params: { id: string } }>('/api/accounts/:id/resume', async (request) => {
    await requireSession(db, request);
    const id = accountId(request.params.id);
    const row = await db.transaction(async (tx) => {
      const current = await lockedAccount(tx, id);
      if (current.state !== 'paused_manual') return current;
      const now = clock();
      const limited = isLimited(current, now);
      const [updated] = await tx
        .update(schema.claudeAccounts)
        .set({
          state: limited ? 'limited' : 'available',
          limitedUntil: limited ? current.limitedUntil : null,
          limitedUntilEstimated: limited && current.limitedUntilEstimated,
          updatedAt: now,
        })
        .where(eq(schema.claudeAccounts.id, current.id))
        .returning();
      if (!updated) throw accountNotFound();
      await recordEvent(tx, {
        actor: 'owner',
        entityType: 'claude_account',
        entityId: current.id,
        type: 'account.resumed',
        payload: {
          label: current.label,
          ...(limited && current.limitedUntil
            ? { limitedUntil: current.limitedUntil.toISOString() }
            : {}),
        },
        at: now,
      });
      return updated;
    });
    request.log.info({ account: row.id }, 'Claude account resumed');
    resumed?.();
    return shown(row);
  });
}

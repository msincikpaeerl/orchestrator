import { schema } from '@orchestrator/db';
import {
  CreateAccountRequest,
  UpdateAccountRequest,
  type AccountListResponse,
  type ClaudeAccount,
} from '@orchestrator/protocol';
import { asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireSession } from '../auth/routes.js';
import type { Database } from '../database.js';
import { recordEvent } from '../events.js';
import { HttpError, parseInput, uniqueViolation } from '../http.js';
import { accountNotFound, toAccount } from './model.js';

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

/**
 * Claude accounts (02, section 9.1): in lot 2 a label, a plan and the maximum concurrent runs;
 * the state is changed by usage limits (step J), never by the owner here.
 */
export function registerAccountRoutes(app: FastifyInstance, { db }: { db: Database }) {
  app.get('/api/accounts', async (request) => {
    await requireSession(db, request);
    const rows = await db
      .select()
      .from(schema.claudeAccounts)
      .orderBy(asc(sql`lower(${schema.claudeAccounts.label})`));
    return { accounts: rows.map(toAccount) } satisfies AccountListResponse;
  });

  app.post('/api/accounts', async (request, reply) => {
    await requireSession(db, request);
    const input = parseInput(CreateAccountRequest, request.body);
    const account = await uniqueLabel(() =>
      db.transaction(async (tx) => {
        const [row] = await tx.insert(schema.claudeAccounts).values(input).returning();
        if (!row) throw new Error('account not inserted');
        await recordEvent(tx, {
          actor: 'owner',
          entityType: 'claude_account',
          entityId: row.id,
          type: 'account.created',
          payload: { label: row.label, plan: row.plan, maxConcurrentRuns: row.maxConcurrentRuns },
        });
        return toAccount(row);
      }),
    );
    request.log.info({ account: account.id }, 'Claude account created');
    return reply.code(201).send(account);
  });

  app.patch<{ Params: { id: string } }>('/api/accounts/:id', async (request) => {
    await requireSession(db, request);
    const id = z.uuid().safeParse(request.params.id);
    if (!id.success) throw accountNotFound();
    const input = parseInput(UpdateAccountRequest, request.body);
    const account = await uniqueLabel(() =>
      db.transaction(async (tx): Promise<ClaudeAccount> => {
        const [current] = await tx
          .select()
          .from(schema.claudeAccounts)
          .where(eq(schema.claudeAccounts.id, id.data))
          .for('update');
        if (!current) throw accountNotFound();
        const fields = (['label', 'plan', 'maxConcurrentRuns'] as const).filter(
          (field) => input[field] !== undefined && input[field] !== current[field],
        );
        if (fields.length === 0) return toAccount(current);
        const [row] = await tx
          .update(schema.claudeAccounts)
          .set({ ...input, updatedAt: new Date() })
          .where(eq(schema.claudeAccounts.id, current.id))
          .returning();
        if (!row) throw accountNotFound();
        await recordEvent(tx, {
          actor: 'owner',
          entityType: 'claude_account',
          entityId: row.id,
          type: 'account.updated',
          payload: {
            label: row.label,
            fields,
            ...(fields.includes('label') ? { previousLabel: current.label } : {}),
            ...(fields.includes('plan') ? { plan: row.plan } : {}),
            ...(fields.includes('maxConcurrentRuns')
              ? { maxConcurrentRuns: row.maxConcurrentRuns }
              : {}),
          },
        });
        return toAccount(row);
      }),
    );
    request.log.info({ account: account.id }, 'Claude account edited');
    return account;
  });
}

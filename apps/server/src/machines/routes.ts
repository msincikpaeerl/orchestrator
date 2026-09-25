import { schema } from '@orchestrator/db';
import {
  ApiError,
  CreateMachineRequest,
  DaemonCloseCode,
  EnrollRequest,
  SetCapabilitiesRequest,
  type EnrollResponse,
  type EnrollmentResponse,
  type Machine,
  type MachineListResponse,
} from '@orchestrator/protocol';
import { asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireSession } from '../auth/routes.js';
import { enrollmentKeys, Throttle } from '../auth/throttle.js';
import type { Database, Executor } from '../database.js';
import { recordEvent } from '../events.js';
import { HttpError, parseInput, uniqueViolation } from '../http.js';
import { resolveSettings } from '../settings/store.js';
import {
  formatEnrollmentCode,
  hashCredential,
  newEnrollmentCode,
  newMachineToken,
} from './credentials.js';
import type { DaemonGateway } from './gateway.js';
import { markOffline } from './gateway.js';
import {
  accountNotFound,
  capabilityLists,
  daemonInstallCommand,
  editCapabilities,
  effectiveCapabilities,
  machineNotFound,
  serverAddress,
  toMachine,
  type MachineRow,
} from './model.js';

export interface MachineRoutesOptions {
  db: Database;
  gateway: DaemonGateway;
  publicUrl: string;
  now?: () => Date;
}

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type IdParams = { Params: { id: string } };

const nameTaken = () =>
  new HttpError(409, 'machine_name_taken', 'Another machine already has this name');
const revoked = () =>
  new HttpError(
    409,
    'machine_revoked',
    'This machine is revoked: only New enrollment code is possible',
  );

/** Machines (02, section 9.2) and the daemon's enrollment (05, section 3.1). */
export function registerMachineRoutes(app: FastifyInstance, options: MachineRoutesOptions) {
  const { db, gateway, publicUrl } = options;
  const now = () => options.now?.() ?? new Date();
  const throttle = new Throttle(db, now);

  async function view(executor: Executor, row: MachineRow): Promise<Machine> {
    const [account] = await executor
      .select({ id: schema.claudeAccounts.id, label: schema.claudeAccounts.label })
      .from(schema.claudeAccounts)
      .where(eq(schema.claudeAccounts.id, row.accountId));
    if (!account) throw accountNotFound();
    return toMachine(row, account, publicUrl);
  }

  /** The machine, locked for the rest of the transaction. */
  async function lockMachine(tx: Executor, id: string): Promise<MachineRow> {
    const parsed = z.uuid().safeParse(id);
    if (!parsed.success) throw machineNotFound();
    const [row] = await tx
      .select()
      .from(schema.machines)
      .where(eq(schema.machines.id, parsed.data))
      .for('update');
    if (!row) throw machineNotFound();
    return row;
  }

  /**
   * A new one-time code for the machine, replacing any earlier one, valid for the current
   * "Enrollment code lifetime"; writes `machine.enrollment_code_created`.
   */
  async function issueCode(tx: Executor, machine: Pick<MachineRow, 'id' | 'name'>) {
    const { enrollmentCodeLifetimeMinutes } = await resolveSettings(tx, [
      'enrollmentCodeLifetimeMinutes',
    ]);
    const code = newEnrollmentCode();
    const expiresAt = new Date(now().getTime() + enrollmentCodeLifetimeMinutes * 60_000);
    await tx
      .update(schema.machines)
      .set({
        enrollmentCodeHash: hashCredential(code),
        enrollmentCodeExpiresAt: expiresAt,
        enrollmentCodeUsedAt: null,
        updatedAt: now(),
      })
      .where(eq(schema.machines.id, machine.id));
    await recordEvent(tx, {
      actor: 'owner',
      entityType: 'machine',
      entityId: machine.id,
      type: 'machine.enrollment_code_created',
      payload: { name: machine.name, expiresAt: expiresAt.toISOString() },
    });
    const shown = formatEnrollmentCode(code);
    const server = serverAddress(publicUrl);
    return {
      code: shown,
      expiresAt: expiresAt.toISOString(),
      installCommand: daemonInstallCommand(publicUrl),
      enrollCommand: `orchestrator-daemon enroll ${server} ${shown}`,
    };
  }

  /** Runs an owner action on one machine in a transaction and answers with the machine. */
  async function act(
    id: string,
    action: (tx: Transaction, machine: MachineRow) => Promise<void>,
  ): Promise<Machine> {
    return db.transaction(async (tx) => {
      const machine = await lockMachine(tx, id);
      await action(tx, machine);
      return view(tx, await lockMachine(tx, machine.id));
    });
  }

  app.get('/api/machines', async (request) => {
    await requireSession(db, request);
    const rows = await db
      .select({ machine: schema.machines, account: schema.claudeAccounts })
      .from(schema.machines)
      .innerJoin(schema.claudeAccounts, eq(schema.claudeAccounts.id, schema.machines.accountId))
      .orderBy(asc(sql`lower(${schema.machines.name})`));
    return {
      machines: rows.map((row) => toMachine(row.machine, row.account, publicUrl)),
    } satisfies MachineListResponse;
  });

  app.get<IdParams>('/api/machines/:id', async (request) => {
    await requireSession(db, request);
    const parsed = z.uuid().safeParse(request.params.id);
    if (!parsed.success) throw machineNotFound();
    const [row] = await db
      .select()
      .from(schema.machines)
      .where(eq(schema.machines.id, parsed.data));
    if (!row) throw machineNotFound();
    return view(db, row);
  });

  app.post('/api/machines', async (request, reply) => {
    await requireSession(db, request);
    const input = parseInput(CreateMachineRequest, request.body);
    let result: EnrollmentResponse;
    try {
      result = await db.transaction(async (tx) => {
        const [account] = await tx
          .select()
          .from(schema.claudeAccounts)
          .where(eq(schema.claudeAccounts.id, input.accountId));
        if (!account) throw accountNotFound();
        const [row] = await tx
          .insert(schema.machines)
          .values({ name: input.name, accountId: account.id })
          .returning();
        if (!row) throw new Error('machine not inserted');
        await recordEvent(tx, {
          actor: 'owner',
          entityType: 'machine',
          entityId: row.id,
          type: 'machine.created',
          payload: { name: row.name, account: account.label },
        });
        const enrollment = await issueCode(tx, row);
        return { machine: await view(tx, await lockMachine(tx, row.id)), enrollment };
      });
    } catch (error) {
      if (uniqueViolation(error) === 'machines_name') throw nameTaken();
      throw error;
    }
    request.log.info({ machine: result.machine.name }, 'machine created');
    return reply.code(201).send(result);
  });

  app.post<IdParams>('/api/machines/:id/enrollment-code', async (request) => {
    await requireSession(db, request);
    const result = await db.transaction(async (tx): Promise<EnrollmentResponse> => {
      const machine = await lockMachine(tx, request.params.id);
      if (machine.enrolledAt && !machine.revokedAt) {
        throw new HttpError(
          409,
          'machine_already_enrolled',
          'This machine is enrolled: revoke it first to enroll it again',
        );
      }
      if (machine.revokedAt) {
        // Back to waiting for enrollment; the earlier token is never valid again.
        await tx
          .update(schema.machines)
          .set({ revokedAt: null, enrolledAt: null, tokenHash: null })
          .where(eq(schema.machines.id, machine.id));
      }
      const enrollment = await issueCode(tx, machine);
      return { machine: await view(tx, await lockMachine(tx, machine.id)), enrollment };
    });
    request.log.info({ machine: result.machine.name }, 'enrollment code created');
    return result;
  });

  for (const [path, disable] of [
    ['disable', true],
    ['enable', false],
  ] as const) {
    app.post<IdParams>(`/api/machines/:id/${path}`, async (request) => {
      await requireSession(db, request);
      const machine = await act(request.params.id, async (tx, row) => {
        if (row.revokedAt) throw revoked();
        if (disable ? row.disabledAt !== null : row.disabledAt === null) return;
        await tx
          .update(schema.machines)
          .set({ disabledAt: disable ? now() : null, updatedAt: now() })
          .where(eq(schema.machines.id, row.id));
        await recordEvent(tx, {
          actor: 'owner',
          entityType: 'machine',
          entityId: row.id,
          type: disable ? 'machine.disabled' : 'machine.enabled',
          payload: { name: row.name },
        });
      });
      request.log.info({ machine: machine.name }, disable ? 'machine disabled' : 'machine enabled');
      return machine;
    });
  }

  app.post<IdParams>('/api/machines/:id/revoke', async (request) => {
    await requireSession(db, request);
    const machine = await act(request.params.id, async (tx, row) => {
      if (row.revokedAt) return;
      if (!row.enrolledAt) {
        throw new HttpError(
          409,
          'machine_not_enrolled',
          'This machine never enrolled: there is no token to revoke',
        );
      }
      // The token hash is kept, so the daemon is told its token was revoked (05, section 3.2).
      await tx
        .update(schema.machines)
        .set({ revokedAt: now(), updatedAt: now() })
        .where(eq(schema.machines.id, row.id));
      await recordEvent(tx, {
        actor: 'owner',
        entityType: 'machine',
        entityId: row.id,
        type: 'machine.revoked',
        payload: { name: row.name },
      });
      await markOffline(tx, row, 'revoked');
    });
    gateway.disconnect(machine.id, DaemonCloseCode.revoked, 'machine revoked');
    request.log.info({ machine: machine.name }, 'machine revoked');
    return machine;
  });

  app.put<IdParams>('/api/machines/:id/capabilities', async (request) => {
    await requireSession(db, request);
    const { capabilities } = parseInput(SetCapabilitiesRequest, request.body);
    const machine = await act(request.params.id, async (tx, row) => {
      if (row.revokedAt) throw revoked();
      const before = capabilityLists(row);
      const after = editCapabilities(before, capabilities);
      if (
        after.added.join() === before.added.join() &&
        after.removed.join() === before.removed.join()
      ) {
        return;
      }
      await tx
        .update(schema.machines)
        .set({
          addedCapabilities: after.added,
          removedCapabilities: after.removed,
          updatedAt: now(),
        })
        .where(eq(schema.machines.id, row.id));
      await recordEvent(tx, {
        actor: 'owner',
        entityType: 'machine',
        entityId: row.id,
        type: 'machine.capabilities_changed',
        payload: { name: row.name, capabilities: effectiveCapabilities(after) },
      });
    });
    request.log.info({ machine: machine.name }, 'machine capabilities edited');
    return machine;
  });

  // `orchestrator-daemon enroll` (05, section 3.1). The body and the answer hold a code and a
  // token: neither is ever logged.
  app.post('/daemon/enroll', async (request, reply) => {
    const keys = enrollmentKeys(request.ip);
    const wait = await throttle.waitSeconds(keys);
    if (wait > 0) {
      request.log.warn({ wait }, 'enrollment refused: too many wrong codes');
      return reply
        .code(429)
        .header('retry-after', String(wait))
        .send({
          error: {
            code: 'too_many_attempts',
            message: `Too many wrong enrollment codes from this address; try again in ${String(wait)} seconds`,
            retryAfterSeconds: wait,
          },
        } satisfies ApiError);
    }
    const parsed = EnrollRequest.safeParse(request.body);
    const code = parsed.success ? parsed.data.code : null;
    const outcome = await db.transaction(async (tx) => {
      const [machine] =
        code === null
          ? []
          : await tx
              .select()
              .from(schema.machines)
              .where(eq(schema.machines.enrollmentCodeHash, hashCredential(code)))
              .for('update');
      if (!machine) {
        return new HttpError(
          404,
          'enrollment_code_unknown',
          'No machine has this enrollment code: check it, or generate a new code in Machines',
        );
      }
      if (machine.enrollmentCodeUsedAt) {
        return new HttpError(
          409,
          'enrollment_code_used',
          'This enrollment code was already used: generate a new code in Machines',
        );
      }
      if (!machine.enrollmentCodeExpiresAt || machine.enrollmentCodeExpiresAt <= now()) {
        const { enrollmentCodeLifetimeMinutes: minutes } = await resolveSettings(tx, [
          'enrollmentCodeLifetimeMinutes',
        ]);
        return new HttpError(
          410,
          'enrollment_code_expired',
          `This enrollment code expired: codes are valid for ${String(minutes)} minutes (setting "Enrollment code lifetime"). Generate a new code in Machines`,
          { setting: { name: 'enrollmentCodeLifetimeMinutes', value: minutes } },
        );
      }
      const token = newMachineToken();
      const at = now();
      // Marked used in the transaction that sets the token: a code enrolls one daemon only.
      await tx
        .update(schema.machines)
        .set({
          tokenHash: hashCredential(token),
          enrollmentCodeUsedAt: at,
          enrolledAt: at,
          updatedAt: at,
        })
        .where(eq(schema.machines.id, machine.id));
      await recordEvent(tx, {
        actor: 'system',
        entityType: 'machine',
        entityId: machine.id,
        type: 'machine.enrolled',
        payload: { name: machine.name },
      });
      return {
        machineId: machine.id,
        machineName: machine.name,
        machineToken: token,
      } satisfies EnrollResponse;
    });
    if (outcome instanceof HttpError) {
      await throttle.recordFailure(keys);
      request.log.warn({ code: outcome.code }, 'enrollment refused');
      throw outcome;
    }
    await throttle.clear(keys);
    request.log.info({ machine: outcome.machineName }, 'machine enrolled');
    return outcome;
  });
}

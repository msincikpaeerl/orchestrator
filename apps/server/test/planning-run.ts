import { randomBytes } from 'node:crypto';
import { schema } from '@orchestrator/db';
import { eq } from 'drizzle-orm';
import type { Database } from '../src/database.js';
import { hashCredential } from '../src/machines/credentials.js';
import { changeRequestStatus } from '../src/requests/model.js';

// A planning run before step E2 starts one (owner's answer 3 of lot 5 step D, answer 12 of step
// D2): the seeded Project Manager's `plan` run of the request on the machine, in `starting`, the
// request `planning` with its `request.status_changed`. The test's scripted daemon plays the run
// with the returned token. Test code only: the real start is step E2's.

/** The Project Manager, seeded at the server's start from `agents/pm.md` (lot 5 step E1a). */
async function plannerProfile(db: Database): Promise<typeof schema.agentProfiles.$inferSelect> {
  const [profile] = await db
    .select()
    .from(schema.agentProfiles)
    .where(eq(schema.agentProfiles.key, 'pm'));
  if (!profile) throw new Error('the pm profile is not seeded');
  return profile;
}

/** Starts a planning run of request `number` on the machine: its id and run token. */
export async function startPlanningRun(
  db: Database,
  input: { request: number; machineId: string; now?: Date },
): Promise<{ runId: string; runToken: string }> {
  const at = input.now ?? new Date();
  const profile = await plannerProfile(db);
  const runToken = `ort_${randomBytes(32).toString('base64url')}`;
  const runId = await db.transaction(async (tx) => {
    const [request] = await tx
      .select()
      .from(schema.requests)
      .where(eq(schema.requests.number, input.request))
      .for('update');
    if (!request) throw new Error(`no request ${String(input.request)}`);
    // A request for a new project has no project: its run has none (lot 5 step E1b).
    const project = (
      request.projectId === null
        ? [null]
        : await tx.select().from(schema.projects).where(eq(schema.projects.id, request.projectId))
    ).at(0);
    const [machine] = await tx
      .select()
      .from(schema.machines)
      .where(eq(schema.machines.id, input.machineId));
    if (project === undefined || !machine?.accountId) throw new Error('no project or no account');
    const [run] = await tx
      .insert(schema.runs)
      .values({
        projectId: project?.id ?? null,
        requestId: request.id,
        profileId: profile.id,
        profileVersion: profile.version,
        purpose: 'plan',
        machineId: machine.id,
        accountId: machine.accountId,
        status: 'starting',
        attempt: 1,
        runTokenHash: hashCredential(runToken),
        acknowledgedAt: at,
        baseBranch: project?.defaultBranch ?? 'main',
        statusSince: at,
        createdAt: at,
        startedAt: at,
      })
      .returning({ id: schema.runs.id });
    if (!run) throw new Error('run not inserted');
    await changeRequestStatus(tx, {
      request,
      to: 'planning',
      cause: 'run_started',
      runId: run.id,
      at,
    });
    return run.id;
  });
  return { runId, runToken };
}

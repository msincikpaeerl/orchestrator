import { randomBytes } from 'node:crypto';
import { schema } from '@orchestrator/db';
import { ROLE_MCP_PERMISSIONS } from '@orchestrator/protocol';
import { eq } from 'drizzle-orm';
import type { Database } from '../src/database.js';
import { hashCredential } from '../src/machines/credentials.js';
import { changeRequestStatus } from '../src/requests/model.js';

// A planning run before step E2 starts one (owner's answer 3 of lot 5 step D, answer 12 of step
// D2): a test planner profile and a `plan` run of the request on the machine, in `starting`, the
// request `planning` with its `request.status_changed`. The test's scripted daemon plays the run
// with the returned token. Test code only: the real start is step E2's.

/** The test planner profile, created once per database. */
async function plannerProfile(db: Database): Promise<typeof schema.agentProfiles.$inferSelect> {
  const [existing] = await db
    .select()
    .from(schema.agentProfiles)
    .where(eq(schema.agentProfiles.key, 'test_planner'));
  if (existing) return existing;
  const [created] = await db
    .insert(schema.agentProfiles)
    .values({
      key: 'test_planner',
      name: 'Test Planner',
      description: 'Plans requests in the tests.',
      role: 'planner',
      instructions: 'You plan requests.',
      model: 'sonnet',
      mcpPermissions: [...ROLE_MCP_PERMISSIONS.planner],
      isDefault: false,
    })
    .returning();
  if (!created) throw new Error('profile not inserted');
  return created;
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
    if (!request?.projectId) throw new Error('a planning run needs a request for a project');
    const [project] = await tx
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, request.projectId));
    const [machine] = await tx
      .select()
      .from(schema.machines)
      .where(eq(schema.machines.id, input.machineId));
    if (!project || !machine?.accountId) throw new Error('no project or no account');
    const [run] = await tx
      .insert(schema.runs)
      .values({
        projectId: project.id,
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
        baseBranch: project.defaultBranch ?? 'main',
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

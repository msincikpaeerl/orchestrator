import { randomUUID } from 'node:crypto';
import { McpPermission, runMcpTools, type RunLimits, type RunStart } from '@orchestrator/protocol';
import { ticketRepository, type TicketRepository, type Workspaces } from '../src/workspace.js';

type Payload = RunStart['payload'];

/** The `run.start` payload of a ticket run: a repository with its ticket branch. */
export type TicketRunStart = Payload & { repository: TicketRepository };

/** A `run.start` payload for a ticket of `owner/name`, with its fields changed by `changes`. */
export function runStartPayload(
  cloneUrl: string,
  changes: Partial<Omit<Payload, 'limits' | 'repository'>> & {
    limits?: Partial<RunLimits>;
    repository?: Partial<TicketRepository>;
  } = {},
): TicketRunStart {
  const { limits, repository, ...rest } = changes;
  return {
    runId: randomUUID(),
    purpose: 'implement',
    subject: { kind: 'ticket', id: randomUUID(), number: 'NOTES-1' },
    repository: {
      owner: 'owner',
      name: 'notes',
      cloneUrl,
      baseBranch: 'main',
      ticketBranch: 't/1-add-notes',
      ...repository,
    },
    commitAuthor: {
      name: 'Web Developer (Orchestrator)',
      email: '1+owner@users.noreply.github.com',
    },
    profile: {
      key: 'web_dev',
      version: 1,
      instructions: 'Common rules and role instructions.',
      model: 'sonnet',
      allowedTools: ['Bash(git commit *)'],
    },
    runToken: 'run-token-for-tests',
    initialPrompt: 'Implement ticket NOTES-1.',
    nudgeMessage: 'Continue, or use ticket_submit, ticket_ask or ticket_give_up.',
    limits: {
      maxRunDurationMinutes: 90,
      idleTimeoutMinutes: 10,
      maxNudgesPerRun: 2,
      waitingRunLifetimeMinutes: 30,
      sessionStartTimeoutSeconds: 30,
      mcpCallTimeoutSeconds: 30,
      claudeCodeMcpToolTimeoutSeconds: 120,
      pushTimeoutSeconds: 60,
      ...limits,
    },
    resumeSessionId: null,
    mcpTools: runMcpTools(McpPermission.options, rest.purpose ?? 'implement'),
    ...rest,
  };
}

/** Prepares a ticket run's workspace: its bare clone is never null. */
export async function prepareTicketRun(
  workspaces: Workspaces,
  start: Payload,
  folder: string,
): Promise<{
  bare: string;
  worktree: string;
  review: Awaited<ReturnType<Workspaces['prepare']>>['review'];
}> {
  const prepared = await workspaces.prepare(start, folder);
  if (prepared.bare === null || ticketRepository(start) === null) {
    throw new Error('not a ticket run: no bare clone');
  }
  return { ...prepared, bare: prepared.bare };
}

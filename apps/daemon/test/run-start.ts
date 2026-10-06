import { randomUUID } from 'node:crypto';
import type { RunLimits, RunStart } from '@orchestrator/protocol';

type Payload = RunStart['payload'];

/** A `run.start` payload for a ticket of `owner/name`, with its fields changed by `changes`. */
export function runStartPayload(
  cloneUrl: string,
  changes: Partial<Omit<Payload, 'limits' | 'repository'>> & {
    limits?: Partial<RunLimits>;
    repository?: Partial<Payload['repository']>;
  } = {},
): Payload {
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
    ...rest,
  };
}

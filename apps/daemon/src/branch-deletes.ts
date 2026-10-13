import { join } from 'node:path';
import { BranchDeleteAnswer, isTicketBranchName, type BranchDelete } from '@orchestrator/protocol';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { DaemonPaths } from './paths.js';
import { readJson, writeJsonAtomic } from './run-files.js';
import type { Workspaces } from './workspace.js';

// The local ticket branch deleted after its pull request's merge (05, section 4.11; lot 3 step
// J2b). The server's word alone decides nothing: the daemon checks that the name is the given
// ticket's branch name, then the bare clone, its worktrees and its own runs (`Workspaces`). Each
// message is applied once: its answer is kept by id, across restarts, and a copy gets it again.

/** How many answers are kept: far more than the server ever has unanswered for one machine. */
export const BRANCH_DELETE_ANSWERS_KEPT = 200;

const AnswersFile = z.array(z.object({ id: z.string(), answer: BranchDeleteAnswer }));
type AnswersFile = z.infer<typeof AnswersFile>;

export function branchDeletesPath(paths: DaemonPaths): string {
  return join(paths.home, 'branch-deletes.json');
}

export interface BranchDeletesContext {
  paths: DaemonPaths;
  workspaces: Workspaces;
  /** The repositories (`owner/name`) of the runs active on the machine. */
  activeRepositories: () => string[];
  log: Logger;
}

export class BranchDeletes {
  private readonly answers: AnswersFile;
  /** Messages being handled, by id: a copy arriving meanwhile shares the first one's answer. */
  private readonly inFlight = new Map<string, Promise<BranchDeleteAnswer>>();

  constructor(private readonly context: BranchDeletesContext) {
    const kept = AnswersFile.safeParse(readJson(branchDeletesPath(context.paths)));
    this.answers = kept.success ? kept.data : [];
  }

  /** The answer to `message`; throws when Git failed, and the server sends it again. */
  handle(message: BranchDelete): Promise<BranchDeleteAnswer> {
    const answered = this.answers.find((entry) => entry.id === message.id);
    if (answered) return Promise.resolve(answered.answer);
    const running = this.inFlight.get(message.id);
    if (running) return running;
    const handling = this.apply(message.payload)
      .then((answer) => {
        this.keep(message.id, answer);
        return answer;
      })
      .finally(() => this.inFlight.delete(message.id));
    this.inFlight.set(message.id, handling);
    return handling;
  }

  private async apply(payload: BranchDelete['payload']): Promise<BranchDeleteAnswer> {
    const { repository, ticket, branch, mergedHead } = payload;
    const number = Number(ticket.slice(ticket.lastIndexOf('-') + 1));
    const log = this.context.log.child({ ticket, branch });
    if (!isTicketBranchName(branch, number)) {
      log.warn('branch delete refused: not the ticket branch name');
      return { outcome: 'not_a_ticket_branch' };
    }
    const name = `${repository.owner}/${repository.name}`;
    const answer = await this.context.workspaces.deleteMergedBranch(
      repository,
      branch,
      mergedHead,
      () => this.context.activeRepositories().includes(name),
    );
    log.info({ repository: name, mergedHead, ...answer }, 'local ticket branch after its merge');
    return answer;
  }

  private keep(id: string, answer: BranchDeleteAnswer): void {
    this.answers.push({ id, answer });
    this.answers.splice(0, Math.max(0, this.answers.length - BRANCH_DELETE_ANSWERS_KEPT));
    try {
      writeJsonAtomic(branchDeletesPath(this.context.paths), this.answers);
    } catch (error) {
      // Kept in memory still: only a copy arriving after a restart would be applied again, which
      // finds the branch gone (`not_found`) or kept as it was.
      this.context.log.error({ err: error }, 'branch delete answers not saved');
    }
  }
}

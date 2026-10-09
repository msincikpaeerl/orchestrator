import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  Ack,
  DaemonRunState,
  RunInput,
  RunResume,
  RunStart,
  RunStop,
} from '@orchestrator/protocol';
import { Outbox } from './outbox.js';
import { RunStateFile, readJson, stateFilePath } from './run-files.js';
import { runFolder } from './run-socket.js';
import { Run, type RunContext } from './run.js';

export type RunCommand = RunStart | RunInput | RunResume | RunStop;

/**
 * The runs of this machine (05, section 4): starts them on `run.start`, passes the server's
 * other commands to them, finds them again after a daemon restart, and removes a run's folder
 * once it has ended and the server acknowledged all its reports.
 */
export class RunManager {
  private readonly runs = new Map<string, Run>();
  /** Set by `shutdown`: a stopping daemon starts nothing. */
  private stopping = false;
  /** Ids of commands already handled: a duplicate is acknowledged again and changes nothing. */
  private readonly handled = new Set<string>();
  readonly outbox: Outbox;
  private readonly context: RunContext;

  constructor(context: Omit<RunContext, 'outbox' | 'onEnded'>) {
    this.outbox = new Outbox(context.paths, context.log, (runId) => void this.drained(runId));
    this.context = {
      ...context,
      outbox: this.outbox,
      onEnded: (run) => {
        if (this.outbox.isEmpty(run.runId)) void this.drained(run.runId);
      },
    };
  }

  private async drained(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (run && !run.ended) return;
    this.runs.delete(runId);
    await rm(runFolder(this.context.paths, runId), { recursive: true, force: true }).catch(
      (error: unknown) => {
        this.context.log.error({ err: error, runId }, 'run folder not removed');
      },
    );
  }

  /** Loads the runs a previous daemon left and finds their sessions (05, section 6). */
  async recover(): Promise<void> {
    const folder = join(this.context.paths.home, 'runs');
    const names = await readdir(folder).catch(() => []);
    for (const runId of names) {
      const data = RunStateFile.safeParse(readJson(stateFilePath(this.context.paths, runId)));
      if (!data.success) {
        this.context.log.warn({ runId }, 'run folder without a readable state.json: left as is');
        continue;
      }
      this.outbox.load(runId);
      const run = Run.load(this.context, data.data);
      this.runs.set(runId, run);
      await run.recover();
      if (run.ended && this.outbox.isEmpty(runId)) await this.drained(runId);
    }
  }

  /** Handles a command of the server; resolves with its `ack` payload. */
  async handle(command: RunCommand): Promise<Ack['payload']> {
    if (this.handled.has(command.id)) return { ok: true };
    // Its runs are no longer watched: a session started now would be left to itself.
    if (this.stopping) return { ok: false, message: 'The daemon is stopping.' };
    const answer = await this.apply(command);
    if (answer.ok) this.handled.add(command.id);
    return answer;
  }

  private async apply(command: RunCommand): Promise<Ack['payload']> {
    const { runId } = command.payload;
    const run = this.runs.get(runId);
    switch (command.type) {
      case 'run.start': {
        if (run) return { ok: true };
        // A session started without its scope would be stopped by a restart (05, section 2).
        const refused = this.context.scopes.problem;
        if (refused !== null) return { ok: false, message: refused };
        const created = Run.create(this.context, command.payload);
        this.runs.set(runId, created);
        created.begin();
        return { ok: true };
      }
      case 'run.input': {
        if (!run) return { ok: false, message: 'No such run on this machine.' };
        const refused = run.input(command.payload.text);
        return refused ? { ok: false, message: refused } : { ok: true };
      }
      case 'run.resume': {
        const problem = this.context.scopes.problem;
        if (problem !== null) return { ok: false, message: problem };
        if (!run) return { ok: false, message: 'No such run on this machine.' };
        const refused = await run.resume(command.payload.claudeSessionId, command.payload.message);
        return refused ? { ok: false, message: refused } : { ok: true };
      }
      case 'run.stop':
        // Stopping a run that already ended changes nothing.
        if (run && !run.ended) await run.stop(command.payload.reason);
        return { ok: true };
    }
  }

  /** Runs whose session or workspace is still on the machine, for `hello` and `status`. */
  list(): {
    runId: string;
    state: DaemonRunState;
    claudeSessionId: string | null;
    ticket: string | null;
    repository: string;
    branch: string;
  }[] {
    return [...this.runs.values()]
      .filter((run) => !run.ended)
      .map((run) => ({
        runId: run.runId,
        state: run.state,
        claudeSessionId: run.claudeSessionId,
        ...run.where,
      }));
  }

  get(runId: string): Run | undefined {
    return this.runs.get(runId);
  }

  /** The daemon is stopping: sessions keep running and are found again at the next start. */
  async shutdown(): Promise<void> {
    this.stopping = true;
    await Promise.all([...this.runs.values()].map((run) => run.shutdown()));
  }
}

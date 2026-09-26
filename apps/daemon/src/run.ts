import { rm } from 'node:fs/promises';
import type { Server } from 'node:net';
import {
  DAEMON_MESSAGE_MAX_BYTES,
  HookInputs,
  TEXT_CEILING,
  claudeCodeSupport,
  maskSecrets,
  CLAUDE_CODE_MIN_VERSION,
  type BranchReport,
  type DaemonRunState,
  type HookAnswer,
  type HookEvent,
  type RunEndReason,
  type RunLogEvent,
  type RunSocketRequest,
  type RunStart,
} from '@orchestrator/protocol';
import type { Logger } from 'pino';
import { findExecutable, runCommand } from './exec.js';
import type { Outbox } from './outbox.js';
import type { DaemonPaths } from './paths.js';
import {
  RunStateFile,
  createRunFolder,
  stateFilePath,
  writeJsonAtomic,
  writeRunFiles,
} from './run-files.js';
import { runSocketPath, serveRunSocket } from './run-socket.js';
import { sessionName, type Tmux } from './tmux.js';
import { TranscriptReader, type LogEntry } from './transcript.js';
import type { TrustRegistry } from './trust.js';
import type { Workspaces } from './workspace.js';

// One run on this machine (05, section 4): its workspace, its Claude Code session in tmux, the
// state machine of section 4.7 driven by hooks, the input queue, nudges and timeouts, the live
// log, and its end. The daemon reports facts; the server decides what they mean for the ticket.

export interface RunContext {
  paths: DaemonPaths;
  log: Logger;
  tmux: Tmux;
  trust: TrustRegistry;
  workspaces: Workspaces;
  outbox: Outbox;
  /** How hooks, the status line and the MCP relay run this daemon (`self.ts`). */
  selfCommand: readonly string[];
  /** `PATH` of sessions, where `claude` is also looked up. */
  toolPath: string;
  /** Absolute path of `env`, which launches Claude Code without `TMUX` and `TMUX_PANE`. */
  envCommand: string;
  /** How long one second of a setting lasts: 1000, shorter in tests. */
  secondMs: number;
  /** Called once a run has ended and its folder may go when its reports are acknowledged. */
  onEnded: (run: Run) => void;
}

/** States whose time counts as working time (05, section 5). */
const WORKING: readonly DaemonRunState[] = ['starting', 'working', 'idle'];

export class Run {
  private readonly log: Logger;
  private socket: Server | null = null;
  private timer: NodeJS.Timeout | undefined;
  private readonly reader: TranscriptReader;
  private releaseStart: (() => void) | null = null;
  private sessionAlive = false;
  private launchedAt = 0;
  private lastActivity = 0;
  private lastTick = 0;
  /** Tool calls started (`PreToolUse`) and not finished (`PostToolUse`): the idle clock pauses. */
  private readonly toolsRunning = new Set<string>();
  private events: RunLogEvent[] = [];
  private ticking = false;
  private ending: Promise<void> | null = null;
  /** Set when the daemon stops: this object no longer acts, the session goes on. */
  private stopped = false;

  private constructor(
    private readonly context: RunContext,
    private readonly data: RunStateFile,
  ) {
    this.log = context.log.child({ runId: data.start.runId, ticket: ticketOf(data.start) });
    this.reader = new TranscriptReader(data.transcriptOffset);
  }

  /** A new run from `run.start`; `begin()` prepares and launches it. */
  static create(context: RunContext, start: RunStart['payload']): Run {
    createRunFolder(context.paths, start.runId);
    const run = new Run(context, {
      start,
      state: 'preparing',
      endReason: null,
      claudeSessionId: start.resumeSessionId,
      transcriptPath: null,
      transcriptOffset: 0,
      skippedLines: 0,
      nextSeq: 0,
      nudgesSent: 0,
      workingMs: 0,
      pendingInputs: [],
      bare: null,
      worktree: null,
    });
    run.save();
    return run;
  }

  /** A run found in `state.json` by a restarted daemon; `recover()` finds its session. */
  static load(context: RunContext, data: RunStateFile): Run {
    return new Run(context, data);
  }

  get runId(): string {
    return this.data.start.runId;
  }

  get state(): DaemonRunState {
    return this.data.state;
  }

  get claudeSessionId(): string | null {
    return this.data.claudeSessionId;
  }

  get ended(): boolean {
    return this.data.state === 'ended';
  }

  private get name(): string {
    return sessionName(this.runId);
  }

  private save(): void {
    this.data.transcriptOffset = this.reader.offset;
    writeJsonAtomic(stateFilePath(this.context.paths, this.runId), this.data);
  }

  private report(state: Exclude<DaemonRunState, 'starting' | 'ended'>): void;
  private report(state: 'starting', claudeCodeVersion: string | null): void;
  private report(state: DaemonRunState, claudeCodeVersion?: string | null): void {
    const base = {
      runId: this.runId,
      at: new Date().toISOString(),
      claudeSessionId: this.data.claudeSessionId,
      sessionAlive: this.sessionAlive,
    };
    this.context.outbox.add(this.runId, {
      type: 'run.state',
      payload:
        state === 'starting'
          ? { ...base, state, claudeCodeVersion: claudeCodeVersion ?? null }
          : { ...base, state: state as Exclude<DaemonRunState, 'starting' | 'ended'> },
    });
  }

  private setState(state: Exclude<DaemonRunState, 'starting' | 'ended'>): void {
    if (this.data.state === state) return;
    this.data.state = state;
    this.save();
    this.report(state);
  }

  // Live log (05, section 4.5).

  private addEvent(entry: LogEntry): void {
    this.events.push({
      ...entry,
      seq: this.data.nextSeq++,
      text: maskSecrets(entry.text).slice(0, TEXT_CEILING),
      tool: entry.tool === null ? null : entry.tool.slice(0, TEXT_CEILING),
    });
  }

  private async readTranscript(): Promise<void> {
    if (!this.data.transcriptPath) return;
    const { entries, skipped } = await this.reader.read(this.data.transcriptPath);
    for (const entry of entries) this.addEvent(entry);
    if (skipped > 0) {
      this.data.skippedLines += skipped;
      this.addEvent({
        at: new Date().toISOString(),
        kind: 'warning',
        tool: null,
        text: `${String(skipped)} transcript line(s) could not be read and were skipped (${String(this.data.skippedLines)} in this run). The log may miss part of the agent's work; the run goes on.`,
      });
    }
  }

  /** Sends the log entries collected, in batches below the message size limit. */
  private flushEvents(): void {
    while (this.events.length > 0) {
      const batch: RunLogEvent[] = [];
      let bytes = 1024;
      while (this.events.length > 0) {
        const next = this.events[0] as RunLogEvent;
        const size = Buffer.byteLength(JSON.stringify(next));
        if (batch.length > 0 && bytes + size > DAEMON_MESSAGE_MAX_BYTES / 2) break;
        batch.push(next);
        this.events.shift();
        bytes += size;
      }
      this.context.outbox.add(this.runId, {
        type: 'run.events',
        payload: { runId: this.runId, events: batch, estimatedUsageUsd: null },
      });
    }
    this.save();
  }

  // Launch (05, sections 4.2 and 4.3).

  /** Prepares the workspace and launches the session with the first message. */
  async begin(): Promise<void> {
    this.report('preparing');
    const { start } = this.data;
    try {
      const folder = createRunFolder(this.context.paths, this.runId);
      const workspace = await this.context.workspaces.prepare(start, folder);
      this.data.bare = workspace.bare;
      this.data.worktree = workspace.worktree;
      this.save();
    } catch (error) {
      this.log.error({ err: error }, 'workspace not prepared');
      await this.end('crashed', `The workspace could not be prepared: ${(error as Error).message}`);
      return;
    }
    await this.launch(start.initialPrompt, start.resumeSessionId);
  }

  private async launch(message: string, resumeSessionId: string | null): Promise<void> {
    const { start } = this.data;
    const claude = findExecutable('claude', this.context.toolPath);
    const version = claude
      ? ((
          await runCommand(claude, ['--version'], {
            env: { ...process.env, PATH: this.context.toolPath },
          })
        )?.stdout.trim() ??
          null) ||
        null
      : null;
    this.data.state = 'starting';
    this.save();
    this.report('starting', version);
    const support = claudeCodeSupport(version);
    if (!claude || support === 'missing' || support === 'below_minimum') {
      await this.end(
        'claude_code_unsupported',
        claude
          ? `Claude Code ${version ?? '(unknown version)'} is older than ${CLAUDE_CODE_MIN_VERSION}, the oldest version the Orchestrator supports: update Claude Code on this machine.`
          : "Claude Code (claude) was not found in the daemon's PATH.",
      );
      return;
    }
    try {
      const files = writeRunFiles(this.context.paths, start, this.context.selfCommand);
      this.socket ??= await serveRunSocket(files.socket, (request) => this.onSocket(request));
      await this.context.trust.ensure(this.data.bare ?? '');
      this.releaseStart = await this.context.trust.beginStart();
      await this.context.tmux.newSession({
        name: this.name,
        cwd: this.data.worktree ?? '',
        env: { CLAUDE_CONFIG_DIR: this.context.paths.claudeConfig, PATH: this.context.toolPath },
        envCommand: this.context.envCommand,
        command: [
          claude,
          '--mcp-config',
          files.mcpConfig,
          '--strict-mcp-config',
          '--setting-sources',
          'user',
          '--settings',
          files.settings,
          '--permission-mode',
          'dontAsk',
          '--model',
          start.profile.model,
          '--append-system-prompt',
          start.profile.instructions,
          ...(resumeSessionId ? ['--resume', resumeSessionId] : []),
          '--',
          message,
        ],
      });
    } catch (error) {
      this.log.error({ err: error }, 'session not launched');
      await this.end('crashed', `Claude Code could not be launched: ${(error as Error).message}`);
      return;
    }
    this.sessionAlive = true;
    this.launchedAt = this.lastActivity = this.lastTick = Date.now();
    this.addEvent({ at: new Date().toISOString(), kind: 'input', tool: null, text: message });
    this.startTimer();
    this.log.info({ session: this.name, version }, 'session launched');
  }

  private startTimer(): void {
    clearInterval(this.timer);
    this.timer = setInterval(() => void this.tick(), this.context.secondMs);
  }

  // Hooks and the status line (05, section 4.5).

  private onSocket(request: RunSocketRequest): Promise<HookAnswer> {
    const answer = Promise.resolve<HookAnswer>({ stdout: '', exitCode: 0 });
    // The status line collector comes with the usage-limit module (plan step G).
    if (request.type !== 'hook' || this.ending) return answer;
    const input = HookInputs[request.event].safeParse(request.input);
    if (!input.success) {
      this.log.warn({ event: request.event }, 'hook input not understood: ignored');
      return answer;
    }
    this.onHook(request.event, input.data);
    return answer;
  }

  private onHook(event: HookEvent, input: { session_id: string; [key: string]: unknown }): void {
    this.lastActivity = Date.now();
    switch (event) {
      case 'SessionStart': {
        this.releaseStart?.();
        this.releaseStart = null;
        const path = typeof input.transcript_path === 'string' ? input.transcript_path : null;
        if (path !== this.data.transcriptPath) this.reader.offset = 0;
        this.data.claudeSessionId = input.session_id;
        this.data.transcriptPath = path;
        if (this.data.state === 'starting') this.setState('working');
        else this.save();
        return;
      }
      case 'PreToolUse':
        this.toolsRunning.add(toolKey(input));
        return;
      case 'PostToolUse':
        this.toolsRunning.delete(toolKey(input));
        return;
      case 'Stop':
        this.toolsRunning.clear();
        this.setState('idle');
        // After the hook's answer, so Claude Code is idle when the text arrives.
        setImmediate(() => void this.afterTurn());
        return;
      case 'StopFailure':
        // A turn ending on an API error: never a nudge (05, section 4.10; plan step G).
        this.toolsRunning.clear();
        this.setState('idle');
        return;
      case 'Notification':
      case 'SessionEnd':
        return;
    }
  }

  /** At the end of a turn: a queued message, else a nudge, else the end (05, section 4.8). */
  private async afterTurn(): Promise<void> {
    if (this.data.state !== 'idle' || this.ending || this.stopped) return;
    const next = this.data.pendingInputs.shift();
    if (next !== undefined) {
      await this.send(next);
      return;
    }
    if (this.data.nudgesSent < this.data.start.limits.maxNudgesPerRun) {
      this.data.nudgesSent++;
      await this.send(this.data.start.nudgeMessage);
      return;
    }
    await this.end('nudges_exhausted', null);
  }

  /** Pastes `text` into the idle session (05, section 4.4). */
  private async send(text: string): Promise<void> {
    this.setState('working');
    this.lastActivity = Date.now();
    this.addEvent({ at: new Date().toISOString(), kind: 'input', tool: null, text });
    try {
      await this.context.tmux.paste(this.name, text);
    } catch (error) {
      this.log.error({ err: error }, 'input not sent');
      await this.end(
        'crashed',
        `A message could not be sent to Claude Code: ${(error as Error).message}`,
      );
    }
  }

  /** `run.input`: sent at once when the session is idle, queued otherwise (05, section 4.4). */
  input(text: string): string | null {
    if (this.ended || this.ending) return 'The run has ended.';
    this.data.pendingInputs.push(text);
    this.save();
    if (this.data.state === 'idle' && this.sessionAlive) void this.afterTurn();
    return null;
  }

  /**
   * `run.resume`: launches the closed session again with `--resume` and `message` (05, section
   * 4.3). Refused while the session is alive.
   */
  async resume(claudeSessionId: string, message: string): Promise<string | null> {
    if (this.ended || this.ending) return 'The run has ended.';
    if (this.sessionAlive) return 'The session is still running.';
    if (!this.data.worktree) return "The run's workspace is not on this machine any more.";
    this.data.claudeSessionId = claudeSessionId;
    await this.launch(message, claudeSessionId);
    return null;
  }

  /** `run.stop` (05, section 3.3). */
  stop(): Promise<void> {
    return this.end('stopped', null);
  }

  // Timeouts and liveness (05, sections 4.2.1 and 5).

  private async tick(): Promise<void> {
    if (this.ticking || this.ending || this.stopped) return;
    this.ticking = true;
    try {
      const now = Date.now();
      if (this.sessionAlive && WORKING.includes(this.data.state)) {
        this.data.workingMs += now - this.lastTick;
      }
      this.lastTick = now;
      await this.readTranscript();
      this.flushEvents();
      const second = this.context.secondMs;
      const { limits } = this.data.start;
      if (this.data.state === 'starting') {
        if (now - this.launchedAt >= limits.sessionStartTimeoutSeconds * second) {
          await this.end(
            'session_start_timeout',
            `Claude Code did not report its start within ${String(limits.sessionStartTimeoutSeconds)} seconds: workspace trust or startup dialog suspected.`,
          );
          return;
        }
      }
      if (this.data.workingMs >= limits.maxRunDurationMinutes * 60 * second) {
        await this.end(
          'max_duration',
          `The run worked for ${String(limits.maxRunDurationMinutes)} minutes, the "Longest run" setting.`,
        );
        return;
      }
      if (
        (this.data.state === 'working' || this.data.state === 'idle') &&
        this.toolsRunning.size === 0 &&
        now - this.lastActivity >= limits.idleTimeoutMinutes * 60 * second
      ) {
        await this.end(
          'idle_timeout',
          `No activity from the agent for ${String(limits.idleTimeoutMinutes)} minutes, the "Idle timeout" setting.`,
        );
        return;
      }
      if (this.sessionAlive && !(await this.context.tmux.hasSession(this.name))) {
        this.sessionAlive = false;
        await this.end('crashed', 'Claude Code exited before the end of the run.');
      }
    } finally {
      this.ticking = false;
    }
  }

  // End and cleanup (05, section 4.11).

  private end(reason: RunEndReason, detail: string | null): Promise<void> {
    this.ending ??= (async () => {
      clearInterval(this.timer);
      this.releaseStart?.();
      this.releaseStart = null;
      if (this.sessionAlive) {
        this.sessionAlive = false;
        await this.context.tmux.killSession(this.name);
      }
      await this.readTranscript().catch(() => undefined);
      let branch: BranchReport | null = null;
      const { bare, worktree } = this.data;
      if (bare) {
        branch = await this.context.workspaces
          .branchReport(bare, this.data.start.repository)
          .catch((error: unknown) => {
            this.log.error({ err: error }, 'branch not read');
            return null;
          });
        if (worktree) {
          await this.context.workspaces.remove(bare, worktree).catch((error: unknown) => {
            this.log.error({ err: error }, 'worktree not removed');
          });
        }
      }
      this.flushEvents();
      this.data.state = 'ended';
      this.data.endReason = reason;
      this.data.worktree = null;
      this.save();
      this.context.outbox.add(this.runId, {
        type: 'run.state',
        payload: {
          runId: this.runId,
          at: new Date().toISOString(),
          claudeSessionId: this.data.claudeSessionId,
          sessionAlive: false,
          state: 'ended',
          reason,
          detail: detail === null ? null : maskSecrets(detail).slice(0, TEXT_CEILING),
          branch,
        },
      });
      await this.closeSocket();
      this.log.info({ reason, detail }, 'run ended');
      this.context.onEnded(this);
    })();
    return this.ending;
  }

  private async closeSocket(): Promise<void> {
    this.socket?.close();
    this.socket = null;
    await rm(runSocketPath(this.context.paths, this.runId), { force: true });
  }

  // Daemon restart (05, section 6).

  /** Finds the session of a run loaded from `state.json` after a daemon restart. */
  async recover(): Promise<void> {
    if (this.ended) return;
    const alive = await this.context.tmux.hasSession(this.name);
    if (this.data.state === 'preparing') {
      await this.end('crashed', 'The daemon stopped while it prepared the workspace.');
      return;
    }
    if (!alive) {
      if (WORKING.includes(this.data.state)) {
        await this.end('crashed', "Claude Code's session ended while the daemon was stopped.");
      }
      // A waiting or paused run keeps its closed session (plan step G).
      return;
    }
    this.sessionAlive = true;
    this.launchedAt = this.lastActivity = this.lastTick = Date.now();
    this.socket = await serveRunSocket(runSocketPath(this.context.paths, this.runId), (request) =>
      this.onSocket(request),
    );
    this.startTimer();
    this.log.info({ state: this.data.state }, 'session found again after a daemon restart');
  }

  /** The daemon is stopping: timers and the socket stop, the session keeps running. */
  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    this.releaseStart?.();
    this.flushEvents();
    this.socket?.close();
    this.socket = null;
    await this.ending;
  }
}

function toolKey(input: Record<string, unknown>): string {
  return typeof input.tool_use_id === 'string' ? input.tool_use_id : String(input.tool_name);
}

function ticketOf(start: RunStart['payload']): string | undefined {
  return start.subject.kind === 'ticket' ? start.subject.number : undefined;
}

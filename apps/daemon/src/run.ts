import { existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Server } from 'node:net';
import { tmpdir } from 'node:os';
import {
  DAEMON_MESSAGE_MAX_BYTES,
  END_REPORT_TEXT_MAX_CHARACTERS,
  SUBMISSION_REPORT_MAX_BYTES,
  cutText,
  encodedBytes,
  HookInputs,
  McpToolName,
  StatusLineInput,
  TEXT_CEILING,
  claudeCodeSupport,
  maskSecrets,
  CLAUDE_CODE_MIN_VERSION,
  SESSION_ALIVE_REFUSAL,
  SESSION_CLOSED_REFUSAL,
  type BranchReport,
  type DaemonRunState,
  type HookAnswer,
  type HookEvent,
  type McpCall,
  type PushResult,
  type RunEndReason,
  type RunLogEvent,
  type RunSocketRequest,
  type RunStart,
  type RunStop,
  type DownloadFailure,
} from '@orchestrator/protocol';
import type { Logger } from 'pino';
import { findExecutable, runCommand } from './exec.js';
import type { Outbox } from './outbox.js';
import type { DaemonPaths } from './paths.js';
import {
  DELIVERED_IDS_KEPT,
  RunStateFile,
  createRunFolder,
  launchCommand,
  stateFilePath,
  writeJsonAtomic,
  writeRunFiles,
} from './run-files.js';
import { checkToolCall, reasonFor, type PermissionScope } from './permissions.js';
import { RUN_MARKER, sweepRun } from './processes.js';
import {
  denyAnswer,
  runFolder,
  runSocketPath,
  serveRunSocket,
  type McpAnswer,
  type RunConnection,
  type RunSocketAnswer,
} from './run-socket.js';
import type { ProcessScopes } from './scopes.js';
import {
  ScopeRefused,
  isRefusal,
  runScopeName,
  scopeFailure,
  type UserSystemd,
} from './systemd.js';
import { sessionName, type Tmux } from './tmux.js';
import { TranscriptReader, type LogEntry } from './transcript.js';
import type { TrustRegistry } from './trust.js';
import { assessTurn, type Assessment, type TurnEnd } from './usage-limit.js';
import { DownloadFailed } from './isolated-git.js';
import { ReviewCommitMoved, ticketRepository, worktreePath, type Workspaces } from './workspace.js';

// One run on this machine (05, section 4): its workspace, its Claude Code session in tmux, the
// state machine of section 4.7 driven by hooks, the permission rules of the `PreToolUse` hook,
// the agent's tool calls relayed to the server and its decisions, usage limits, the input queue,
// nudges and timeouts, the waiting run lifetime, the live log, and its end. The daemon reports
// facts; the server decides what they mean for the ticket.

export interface RunContext {
  paths: DaemonPaths;
  log: Logger;
  tmux: Tmux;
  trust: TrustRegistry;
  workspaces: Workspaces;
  outbox: Outbox;
  /**
   * Sends an agent's tool call to the server and resolves with its result, or `UNAVAILABLE` when
   * disconnected or after `timeoutSeconds` (06, section 1).
   */
  callServer: (call: McpCall['payload'], timeoutSeconds: number) => Promise<McpAnswer>;
  /** How hooks, the status line and the MCP relay run this daemon (`self.ts`). */
  selfCommand: readonly string[];
  /** `PATH` of sessions, where `claude` is also looked up. */
  toolPath: string;
  /** Absolute path of `env`, which launches Claude Code without `TMUX` and `TMUX_PANE`. */
  envCommand: string;
  /** How long one second of a setting lasts: 1000, shorter in tests. */
  secondMs: number;
  /** The user's systemd, where it runs: each Claude Code then gets a scope of its own. */
  systemd: UserSystemd | null;
  /** Start of the systemd unit names (`systemd.ts`). */
  unitPrefix: string;
  /** Whether sessions may start; told when a run's scope cannot be created (05, section 2). */
  scopes: ProcessScopes;
  /** Called once a run has ended and its folder may go when its reports are acknowledged. */
  onEnded: (run: Run) => void;
}

/** Purposes whose runs push their ticket branch (05, section 4.9); a review run never does. */
const PUSHING: readonly RunStart['payload']['purpose'][] = ['implement', 'fix_review'];

/** States in which a closed session takes no `run.input`, only `run.resume` (05, section 4.4). */
const CLOSED_STATES: readonly DaemonRunState[] = ['waiting_human', 'quota_paused', 'waiting_ci'];

/** States whose time counts as working time (05, section 5). */
const WORKING: readonly DaemonRunState[] = ['starting', 'working', 'idle'];

/** The end a failed preparation or launch asks for, applied once the set-up is over. */
interface StartFailure {
  reason: RunEndReason;
  detail: string;
}

export class Run {
  private readonly log: Logger;
  private socket: Server | null = null;
  private timer: NodeJS.Timeout | undefined;
  private readonly reader: TranscriptReader;
  private releaseStart: (() => void) | null = null;
  private sessionAlive = false;
  private launchedAt = 0;
  /** From `SessionStart` until the launch's message is taken: the second start window. */
  private messageWaitSince: number | null = null;
  private lastActivity = 0;
  private lastTick = 0;
  /** Tool calls started (`PreToolUse`) and not finished (`PostToolUse`): the idle clock pauses. */
  private readonly toolsRunning = new Set<string>();
  /** The connections to the run's socket not closed yet, logged at a session kill. */
  private readonly connections = new Set<RunConnection>();
  private events: RunLogEvent[] = [];
  private ticking = false;
  /** Work started from a timer or a hook's answer, awaited when the daemon stops. */
  private readonly inFlight = new Set<Promise<void>>();
  /** Between a turn's `Stop` and `afterTurn`: messages wait for `afterTurn`. */
  private turnEnding = false;
  private ending: Promise<void> | null = null;
  /**
   * The set-up in flight (a preparation, a download before `run.resume`, a launch): the end waits
   * for it, so a stop that lands meanwhile wins (lot 3 step J2s).
   */
  private settingUp: Promise<unknown> | null = null;
  /** GitHub's head of the ticket branch when a review's preparation found it moved. */
  private movedHead: string | null = null;
  /** Why the project's download at the preparation failed (lot 3 step K2). */
  private download: DownloadFailure | null = null;
  /** Set when the daemon stops: this object no longer acts, the session goes on. */
  private stopped = false;

  private constructor(
    private readonly context: RunContext,
    private readonly data: RunStateFile,
  ) {
    this.log = context.log.child({ runId: data.start.runId, ticket: ticketOf(data.start) });
    this.reader = new TranscriptReader(data.transcriptOffset);
    this.reader.lastApiError = data.transcriptApiError;
    this.reader.costUsd = data.transcriptCostUsd;
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
      reviewStart: null,
      decision: null,
      turnToolUsed: false,
      waitingSince: null,
      statusLine: null,
      transcriptApiError: null,
      transcriptCostUsd: null,
      deliveredIds: [],
      messageTaken: false,
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

  /**
   * Its ticket, and the repository and branch it works on, for `status`: a planning run has no
   * ticket branch, and for a new project no repository.
   */
  get where(): {
    ticket: string | null;
    request: string | null;
    repository: string | null;
    branch: string | null;
  } {
    const { repository, subject } = this.data.start;
    return {
      ticket: ticketOf(this.data.start) ?? null,
      request: subject.kind === 'request' ? subject.id : null,
      repository: repository ? `${repository.owner}/${repository.name}` : null,
      branch: repository?.ticketBranch ?? null,
    };
  }

  get limits(): RunStart['payload']['limits'] {
    return this.data.start.limits;
  }

  get ended(): boolean {
    return this.data.state === 'ended';
  }

  private get name(): string {
    return sessionName(this.runId);
  }

  /**
   * Writes `state.json`. A failed write (folder removed, disk full) is logged and the run goes
   * on: the next tick writes the state again.
   */
  private save(): void {
    this.data.transcriptOffset = this.reader.offset;
    this.data.transcriptApiError = this.reader.lastApiError;
    this.data.transcriptCostUsd = this.reader.costUsd;
    try {
      writeJsonAtomic(stateFilePath(this.context.paths, this.runId), this.data);
    } catch (error) {
      this.log.error({ err: error }, 'state.json not written: written again at the next tick');
    }
  }

  /**
   * Runs `work` apart from its caller: an error is logged, never left as an unhandled rejection
   * (which stops Node.js, and with it the daemon), and `shutdown()` awaits the work in flight.
   */
  private background(what: string, work: () => Promise<void>): void {
    const running = work()
      .catch((error: unknown) => {
        this.log.error({ err: error }, `${what} failed`);
      })
      .finally(() => this.inFlight.delete(running));
    this.inFlight.add(running);
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
        payload: { runId: this.runId, events: batch, estimatedUsageUsd: this.estimatedUsage() },
      });
    }
    this.save();
  }

  /** The status line's cost, else the transcript's last `cost-state` (05, section 4.5). */
  private estimatedUsage(): number | null {
    const cost = this.data.statusLine?.cost?.total_cost_usd;
    return cost !== undefined && cost >= 0 ? cost : this.reader.costUsd;
  }

  // Launch (05, sections 4.2 and 4.3).

  /** Prepares the workspace and launches the session with the first message, in the background. */
  begin(): void {
    this.background('start', () => this.prepareAndLaunch());
  }

  private async prepareAndLaunch(): Promise<void> {
    this.report('preparing');
    const { start } = this.data;
    const failure = await this.setUp(async (): Promise<StartFailure | null> => {
      try {
        const folder = createRunFolder(this.context.paths, this.runId);
        const workspace = await this.context.workspaces.prepare(start, folder);
        this.data.bare = workspace.bare;
        this.data.worktree = workspace.worktree;
        this.data.reviewStart = workspace.review;
        this.save();
      } catch (error) {
        if (this.stopping()) return null;
        if (error instanceof DownloadFailed) {
          // Not the agent's failure: GitHub, the credential or Longest push (lot 3 step K2).
          this.log.warn({ err: error, download: error.failure }, 'project not downloaded');
          this.download = error.failure;
          return {
            reason: 'download_failed',
            detail: `The project could not be downloaded from GitHub: ${error.failure.message}`,
          };
        }
        if (error instanceof ReviewCommitMoved) {
          this.log.warn({ err: error }, 'review commit no longer the head on GitHub');
          this.movedHead = error.head;
          return { reason: 'review_branch_moved', detail: error.message };
        }
        this.log.error({ err: error }, 'workspace not prepared');
        return {
          reason: 'crashed',
          detail: `The workspace could not be prepared: ${(error as Error).message}`,
        };
      }
      return this.launch(start.initialPrompt, start.resumeSessionId);
    });
    if (failure) await this.end(failure.reason, failure.detail);
  }

  /**
   * The run was stopped or has ended: nothing more is set up. A method, read again after every
   * `await`, where a property would stay narrowed.
   */
  private stopping(): boolean {
    return this.ending !== null;
  }

  /**
   * Runs `work`, a set-up before the session runs, as the set-up in flight that the end waits
   * for. `work` checks `stopping` after each step and never awaits the end: it returns the end it
   * asks for, applied by its caller once the set-up is over.
   */
  private async setUp<T>(work: () => Promise<T>): Promise<T> {
    const running = work();
    this.settingUp = running.catch(() => undefined);
    try {
      return await running;
    } finally {
      this.settingUp = null;
    }
  }

  /**
   * Launches the session, unless the run is stopping: checked after each step and just before
   * the launch itself. Returns the end it asks for when the launch fails; called within `setUp`.
   */
  private async launch(
    message: string,
    resumeSessionId: string | null,
  ): Promise<StartFailure | null> {
    if (this.stopping()) return null;
    const { start } = this.data;
    // Never an agent without its rules or its task (lot 5 step 5bis D): the server's fault,
    // never the agent's, so not a failed attempt.
    const missing = [
      ...(start.profile.instructions.trim() ? [] : ['instructions']),
      ...(message.trim() ? [] : ['message']),
    ];
    if (missing.length > 0) {
      return {
        reason: 'launch_failed',
        detail: `Claude Code was not started: the run has no ${missing.join(' and no ')}.`,
      };
    }
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
    if (this.stopping()) return null;
    this.data.state = 'starting';
    this.data.messageTaken = false;
    this.messageWaitSince = null;
    this.save();
    this.report('starting', version);
    const support = claudeCodeSupport(version);
    if (!claude || support === 'missing' || support === 'below_minimum') {
      return {
        reason: 'claude_code_unsupported',
        detail: claude
          ? `Claude Code ${version ?? '(unknown version)'} is older than ${CLAUDE_CODE_MIN_VERSION}, the oldest version the Orchestrator supports: update Claude Code on this machine.`
          : "Claude Code (claude) was not found in the daemon's PATH.",
      };
    }
    try {
      const files = writeRunFiles(this.context.paths, start, this.context.selfCommand, message);
      this.socket ??= await serveRunSocket(
        files.socket,
        (request) => this.onSocket(request),
        this.connections,
      );
      // A worktree is trusted through its bare clone, a scratch folder for its own path.
      await this.context.trust.ensure(this.data.bare ?? this.data.worktree ?? '');
      this.releaseStart = await this.context.trust.beginStart();
      await Promise.all(Object.values(this.scopeFiles).map((file) => rm(file, { force: true })));
      // The last moment a stop can keep the session from being launched; one landing during the
      // launch closes it at the end, which waits for this set-up.
      if (this.stopping()) return null;
      await this.context.tmux.newSession({
        name: this.name,
        cwd: this.data.worktree ?? '',
        env: {
          CLAUDE_CONFIG_DIR: this.context.paths.claudeConfig,
          PATH: this.context.toolPath,
          // No Git command of the agent prompts or opens Git Credential Manager (05, section 7).
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'never',
          // Git never looks above a run's folder for a repository: a planning run's scratch
          // folder has no Git, even when a parent folder is a repository (05, section 4.3).
          GIT_CEILING_DIRECTORIES: join(this.context.paths.home, 'worktrees'),
          // Playwright downloads and finds its browsers in the daemon's folder, never in the
          // home folder's cache (05, section 2).
          PLAYWRIGHT_BROWSERS_PATH: this.context.paths.browsers,
          // Inherited by every process of the run, found again by the sweep (05, section 4.11).
          [RUN_MARKER]: this.runId,
        },
        envCommand: this.context.envCommand,
        // The texts go through the run's files, never tmux's command (lot 5 step 5bis C).
        command: this.scoped(
          launchCommand(this.launchTools, claude, {
            mcpConfig: files.mcpConfig,
            settings: files.settings,
            model: start.profile.model,
            resumeSessionId,
            texts: files.texts,
          }),
        ),
      });
    } catch (error) {
      this.log.error({ err: error }, 'session not launched');
      // systemd-run refused the tmux server's scope (05, section 2).
      if (error instanceof ScopeRefused) return this.scopeFailed(error.reason);
      // The machine's fault, never the agent's: not a failed attempt (lot 5 step 5bis C).
      return {
        reason: 'launch_failed',
        detail: `Claude Code could not be started on this machine (${(error as Error).message}). Running it again on this machine will not help until that is fixed, and it is not the ticket's fault.`,
      };
    }
    this.sessionAlive = true;
    if (this.stopping()) return null;
    this.launchedAt = this.lastActivity = this.lastTick = Date.now();
    this.newTurn();
    this.addEvent({ at: new Date().toISOString(), kind: 'input', tool: null, text: message });
    this.startTimer();
    this.log.info({ session: this.name, version }, 'session launched');
    return null;
  }

  /** The shell and the `cat` of the launcher, by absolute path (05, section 4.3). */
  private get launchTools(): { shell: string; cat: string } {
    return {
      shell: findExecutable('sh', this.context.toolPath) ?? '/bin/sh',
      cat: findExecutable('cat', this.context.toolPath) ?? '/bin/cat',
    };
  }

  /**
   * Why the launcher started no Claude Code (`LAUNCH_SCRIPT`): a text it could not read or that
   * read as empty; null when it started Claude Code.
   */
  private launchError(): string | null {
    try {
      return (
        readFileSync(join(runFolder(this.context.paths, this.runId), 'launch-error'), 'utf8')
          .trim()
          .replace(/\s+/g, ' ') || null
      );
    } catch {
      return null;
    }
  }

  /** The run's systemd scope (05, section 4.11). */
  private get scopeUnit(): string {
    return runScopeName(this.context.unitPrefix, this.runId);
  }

  /**
   * The files of the run's scope (05, section 2): `started`, written inside the scope before
   * Claude Code starts; `error` and `exit`, systemd-run's error output and exit status, written
   * by the wrapper outside the scope, the exit status only when `started` is missing.
   */
  private get scopeFiles(): { started: string; error: string; exit: string } {
    const folder = runFolder(this.context.paths, this.runId);
    return {
      started: join(folder, 'scope-started'),
      error: join(folder, 'scope-error'),
      exit: join(folder, 'scope-exit'),
    };
  }

  /**
   * Claude Code in the run's own scope, where the user's systemd runs. A wrapper outside the
   * scope runs systemd-run with its error output in a file, and records its exit status when
   * the scope never started Claude Code; inside the scope, a shell writes the `started` marker,
   * then replaces itself with Claude Code, its error output back on the terminal. The paths and
   * the command are arguments, never part of the scripts.
   */
  private scoped(command: string[]): string[] {
    const systemd = this.context.systemd;
    if (!systemd) return command;
    const shell = findExecutable('sh', this.context.toolPath) ?? '/bin/sh';
    const { started, error, exit } = this.scopeFiles;
    return [
      shell,
      '-c',
      'm=$1 e=$2 x=$3; shift 3; "$@" 2>"$e"; s=$?; [ -e "$m" ] || echo "$s" > "$x"; exit "$s"',
      'orchestrator-scope',
      started,
      error,
      exit,
      ...systemd.markedScopeCommand(this.scopeUnit, started, command, {
        shell,
        terminal: true,
      }),
    ];
  }

  /**
   * Why the session ended without its scope, when systemd-run itself failed: it ended with its
   * own exit status (not a signal) before the scope started Claude Code. Null otherwise, for
   * example when the session was closed during the launch (05, section 2).
   */
  private scopeRefusal(): string | null {
    const { started, error, exit } = this.scopeFiles;
    if (existsSync(started)) return null;
    let code: number;
    try {
      code = Number(readFileSync(exit, 'utf8').trim());
    } catch {
      return null;
    }
    if (!Number.isInteger(code) || !isRefusal(code)) return null;
    let said = '';
    try {
      said = readFileSync(error, 'utf8');
    } catch {
      // No message: the exit status says it.
    }
    return scopeFailure(code, said);
  }

  /**
   * The run's scope could not be created (05, section 2): the run fails with the reason it
   * returns, and the daemon starts no more sessions until it is restarted.
   */
  private scopeFailed(reason: string): StartFailure {
    this.log.error({ reason }, "the run's process scope could not be created");
    this.context.scopes.fail(reason);
    return {
      reason: 'process_scope_failed',
      detail: `Claude Code could not be started in the run's process scope (${reason}). The machine takes no runs until this is fixed: see its problem in Needs you.`,
    };
  }

  /**
   * After the tmux session closed: the run's scope stopped, then the processes still carrying
   * the run's marker (05, section 4.11; lot 2 plan step K).
   */
  private async stopProcesses(): Promise<void> {
    try {
      await this.context.systemd?.stopScope(this.scopeUnit);
      await sweepRun(this.runId, this.log);
    } catch (error) {
      this.log.error({ err: error }, 'processes of the run not stopped');
    }
  }

  private startTimer(): void {
    clearInterval(this.timer);
    if (this.stopped) return;
    this.timer = setInterval(() => {
      this.tick();
    }, this.context.secondMs);
  }

  // Hooks, the status line and the MCP relay (05, sections 4.5 and 4.6; 06, section 1).

  /** Where the agent may work (05, section 4.6). */
  private get scope(): PermissionScope {
    const { paths } = this.context;
    return {
      worktree: this.data.worktree ?? '',
      daemonHome: paths.home,
      userHome: paths.userHome,
      tempDirs: [...new Set(['/tmp', tmpdir()])],
    };
  }

  private async onSocket(request: RunSocketRequest): Promise<RunSocketAnswer> {
    const pass: HookAnswer = { stdout: '', exitCode: 0 };
    if (request.type === 'mcp') return this.onMcp(request.tool, request.arguments);
    if (request.type === 'tools') return { tools: this.data.start.mcpTools };
    if (this.ending) {
      return request.type === 'hook' && request.event === 'PreToolUse'
        ? denyAnswer('The run has ended.')
        : pass;
    }
    if (request.type === 'status_line') {
      const input = StatusLineInput.safeParse(request.input);
      // Kept, and saved with the next log batch: the command runs at each refresh.
      if (input.success) this.data.statusLine = input.data;
      return pass;
    }
    const input = HookInputs[request.event].safeParse(request.input);
    if (!input.success) {
      this.log.warn({ event: request.event }, 'hook input not understood: ignored');
      // An unreadable tool call is refused, as when the daemon is unreachable.
      return request.event === 'PreToolUse' ? denyAnswer('Orchestrator daemon unavailable') : pass;
    }
    return this.onHook(request.event, input.data);
  }

  private onHook(
    event: HookEvent,
    input: { session_id: string; [key: string]: unknown },
  ): HookAnswer {
    const pass: HookAnswer = { stdout: '', exitCode: 0 };
    this.lastActivity = Date.now();
    switch (event) {
      case 'SessionStart': {
        this.releaseStart?.();
        this.releaseStart = null;
        const path = typeof input.transcript_path === 'string' ? input.transcript_path : null;
        if (path !== this.data.transcriptPath) this.reader.offset = 0;
        this.data.claudeSessionId = input.session_id;
        this.data.transcriptPath = path;
        if (!this.data.messageTaken) this.messageWaitSince ??= Date.now();
        if (this.data.state === 'starting') this.setState('working');
        else this.save();
        return pass;
      }
      case 'UserPromptSubmit': {
        // Any text counts, never compared with the message sent: Claude Code may trim or
        // normalise it (owner's rule, lot 5 step 5bis E). Nothing printed, exit 0: this hook's
        // output would reach the agent's context, and exit 2 would block the message.
        if (!this.data.messageTaken && typeof input.prompt === 'string' && input.prompt.trim()) {
          this.data.messageTaken = true;
          this.messageWaitSince = null;
          this.save();
        }
        return pass;
      }
      case 'PreToolUse': {
        this.data.turnToolUsed = true;
        const tool = String(input.tool_name);
        const found = checkToolCall(this.scope, tool, input.tool_input);
        if (found !== null) {
          const reason = reasonFor(this.data.start.purpose, found);
          this.log.info({ tool, reason }, 'tool call refused');
          return denyAnswer(reason);
        }
        this.toolsRunning.add(toolKey(input));
        return pass;
      }
      case 'PostToolUse':
        this.toolsRunning.delete(toolKey(input));
        return pass;
      case 'Stop':
      case 'StopFailure': {
        this.toolsRunning.clear();
        this.setState('idle');
        const message =
          typeof input.last_assistant_message === 'string' ? input.last_assistant_message : null;
        const end: TurnEnd =
          event === 'Stop'
            ? { kind: 'stop', message }
            : {
                kind: 'stop_failure',
                error: typeof input.error === 'string' ? input.error : null,
                message,
              };
        // After the hook's answer, so Claude Code is idle when a message arrives.
        this.turnEnding = true;
        setImmediate(() => {
          this.background('end of turn', () => this.afterTurn(end));
        });
        return pass;
      }
      case 'Notification':
      case 'SessionEnd':
        return pass;
    }
  }

  /**
   * A tool call of the agent, relayed to the server with the run token (06, section 1). An
   * accepted decision tool is remembered until the turn ends (05, section 4.8).
   */
  private async onMcp(name: string, args: Record<string, unknown>): Promise<McpAnswer> {
    if (this.ended || this.ending) {
      return { ok: false, error: { code: 'UNAVAILABLE', message: 'This run has ended.' } };
    }
    const tool = McpToolName.safeParse(name);
    if (!tool.success) {
      return {
        ok: false,
        error: {
          code: 'VALIDATION_FAILED',
          message: `Unknown tool "${name.slice(0, 100)}". The Orchestrator's tools are: ${McpToolName.options.join(', ')}.`,
        },
      };
    }
    const { start } = this.data;
    const timeout = start.limits.mcpCallTimeoutSeconds;
    let call: McpCall['payload'];
    if (tool.data === 'ticket_submit') {
      // Refused before anything is read or pushed: the call must fit in one message with the
      // facts (04, section 8; lot 3 step F).
      const size = encodedBytes(args);
      if (size > SUBMISSION_REPORT_MAX_BYTES) {
        return {
          ok: false,
          error: {
            code: 'VALIDATION_FAILED',
            message: `Your DoD report is ${String(size)} bytes, above the ${String(SUBMISSION_REPORT_MAX_BYTES)} bytes the Orchestrator accepts. Shorten its texts (the summary and the justifications) and submit again.`,
          },
        };
      }
      const { bare, worktree } = this.data;
      const repository = ticketRepository(start);
      const facts =
        bare && worktree && repository
          ? await this.context.workspaces
              .facts(bare, worktree, repository, this.runId)
              .catch((error: unknown) => {
                this.log.error({ err: error }, 'worktree facts not read');
                return null;
              })
          : null;
      if (!facts) {
        return {
          ok: false,
          error: {
            code: 'UNAVAILABLE',
            message:
              'The Orchestrator could not read your worktree and branch. Check that your work is committed on the ticket branch, then try again.',
          },
        };
      }
      // Pushed before the call is forwarded, when there is something to push (05, section 4.9):
      // the head read with the facts is the one pushed.
      if (bare && facts.clean && facts.branch.commitsAhead.length > 0) {
        facts.push = await this.context.workspaces.push(
          start,
          bare,
          runFolder(this.context.paths, this.runId),
          facts.branch.head,
        );
        this.log.info({ push: facts.push }, 'ticket branch pushed at submission');
        // The agent cannot fix a failed push: the run ends at the turn's end (lot 3 step F).
        if (facts.push.status === 'failed') {
          this.data.decision = 'push_failed';
          this.save();
        }
      }
      call = { tool: 'ticket_submit', runToken: start.runToken, input: args, workspace: facts };
    } else {
      call = { tool: tool.data, runToken: start.runToken, input: args };
    }
    const answer = await this.context.callServer(call, timeout);
    if (answer.ok) {
      // `pending_ci`: the run waits for CI at the turn's end instead of ending (protocol 2).
      const decision =
        tool.data === 'ticket_submit' && answer.output.result === 'pending_ci'
          ? 'waiting_ci'
          : DECISIONS[tool.data];
      if (decision && this.data.decision !== 'push_failed') {
        this.data.decision = decision;
        this.save();
      }
    }
    return answer;
  }

  /**
   * At the end of a turn (05, sections 4.8 and 4.10): a usage limit, detected or suspected,
   * pauses the run; else the turn's decision applies; else a queued message is sent; else a
   * nudge, or the end once the nudges are used up.
   */
  private async afterTurn(end: TurnEnd): Promise<void> {
    try {
      await this.decideAfterTurn(end);
    } finally {
      this.turnEnding = false;
    }
  }

  /** The turn's end can still be handled: nothing sent, stopped or ended meanwhile. */
  private turnStillEnded(): boolean {
    return this.data.state === 'idle' && !this.ending && !this.stopped;
  }

  private async decideAfterTurn(end: TurnEnd): Promise<void> {
    if (!this.turnStillEnded()) return;
    await this.readTranscript();
    // A message or a stop may have come while the transcript was read.
    if (!this.turnStillEnded()) return;
    const limit = this.assess(end);
    if (limit) {
      await this.pauseForQuota(limit);
      return;
    }
    const { decision } = this.data;
    if (decision === 'submitted' || decision === 'gave_up' || decision === 'push_failed') {
      await this.end(decision, null);
      return;
    }
    if (decision === 'waiting_ci') {
      // No reminder, no working time, no idle timeout: the server ends the wait (05, section 4.9).
      this.setState('waiting_ci');
      // A CI round may have come during the turn that handed the work in: queued and
      // acknowledged then, it is sent now (owner's review, lot 3 step G2b).
      await this.sendQueued();
      return;
    }
    if (await this.sendQueued()) return;
    if (decision === 'asked') {
      this.waitForOwner();
      return;
    }
    if (this.data.nudgesSent < this.data.start.limits.maxNudgesPerRun) {
      this.data.nudgesSent++;
      await this.send(this.data.start.nudgeMessage);
      return;
    }
    await this.end('nudges_exhausted', null);
  }

  private assess(end: TurnEnd): Assessment {
    return assessTurn({
      end,
      toolUsed: this.data.turnToolUsed,
      transcriptApiError: this.reader.lastApiError,
      statusLine: this.data.statusLine,
      now: new Date(),
    });
  }

  /** Sends the first queued message when the session can take it; false when none was sent. */
  private async sendQueued(): Promise<boolean> {
    if (!this.sessionAlive || !['idle', 'waiting_human', 'waiting_ci'].includes(this.data.state)) {
      return false;
    }
    const next = this.data.pendingInputs.shift();
    if (next === undefined) return false;
    await this.send(next);
    return true;
  }

  /** A new turn starts: its tool use, decision and API-error mark start empty. */
  private newTurn(): void {
    this.data.decision = null;
    this.data.turnToolUsed = false;
    this.data.waitingSince = null;
    this.reader.lastApiError = null;
    this.save();
  }

  /** Pastes `text` into the idle session (05, section 4.4). */
  private async send(text: string): Promise<void> {
    this.newTurn();
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

  /** The agent asked the owner: the run waits, its session alive for the lifetime (05, section 4.8). */
  private waitForOwner(): void {
    this.data.waitingSince = Date.now();
    this.setState('waiting_human');
  }

  /**
   * Closes the tmux session and keeps the worktree and the Claude session id, for a run waiting
   * for the owner or paused on a usage limit (05, sections 4.8 and 4.10).
   */
  /**
   * Kills the tmux session, logging it and each connection to the run's socket still open at that
   * moment (05, section 4.11; lot 3 decision Q32): a hook command killed with the session shows
   * as a hook error in the session, which only these lines can explain afterwards.
   */
  private async killSession(why: string): Promise<void> {
    const now = Date.now();
    this.log.info(
      { why, openConnections: this.connections.size },
      'killing the Claude Code session',
    );
    for (const connection of this.connections) {
      this.log.info(
        {
          request: connection.request ?? 'not read yet',
          answered: connection.answered,
          openMs: now - connection.since,
        },
        "connection to the run's socket still open as the session is killed",
      );
    }
    await this.context.tmux.killSession(this.name);
  }

  private async closeSession(): Promise<void> {
    clearInterval(this.timer);
    this.releaseStart?.();
    this.releaseStart = null;
    this.toolsRunning.clear();
    if (this.sessionAlive) {
      this.sessionAlive = false;
      await this.killSession('the session closed, the run kept');
    }
    await this.stopProcesses();
    await this.readTranscript().catch(() => undefined);
    this.flushEvents();
    await this.closeSocket();
  }

  /** A usage limit, detected or suspected: no nudge, the session closed (05, section 4.10). */
  private async pauseForQuota(limit: NonNullable<Assessment>): Promise<void> {
    this.log.warn({ kind: limit.kind, evidence: limit.evidence }, 'usage limit: run paused');
    this.context.outbox.add(this.runId, {
      type: 'run.quota_limited',
      payload:
        limit.kind === 'detected'
          ? {
              runId: this.runId,
              kind: 'detected',
              resetsAt: limit.resetsAt,
              evidence: limit.evidence,
            }
          : { runId: this.runId, kind: 'suspected', evidence: limit.evidence },
    });
    await this.closeSession();
    this.data.waitingSince = null;
    this.setState('quota_paused');
  }

  /**
   * `run.input`: sent at once when the session is idle, waiting for the owner or waiting for CI
   * (a CI result, lot 3 step G2a), queued while the agent works; refused once the session was
   * closed (05, section 4.4). With `fetchBase`, the base branch is downloaded first, and a failed
   * download refuses the message, which never reaches the agent.
   */
  async input(id: string, text: string, fetchBase = false): Promise<string | null> {
    const refused = this.inputRefused() ?? this.fetchBaseRefused(fetchBase);
    if (refused !== null) return refused;
    if (fetchBase) {
      const failed = await this.fetchBase();
      if (failed !== null) return failed;
      // The run may have ended, or its session closed, during the download.
      const meanwhile = this.inputRefused();
      if (meanwhile !== null) return meanwhile;
    }
    this.data.pendingInputs.push(text);
    this.remember(id);
    this.save();
    // Between a turn's end and `afterTurn`, the queue waits: `afterTurn` sends it first.
    if (['waiting_human', 'waiting_ci'].includes(this.data.state) || !this.turnEnding) {
      this.background('queued message', async () => {
        await this.sendQueued();
      });
    }
    return null;
  }

  /**
   * `run.resume`: launches the closed session again with `--resume` and `message` (05, section
   * 4.3). Refused while the session is alive. The download and the launch are a set-up: a stop
   * landing during them wins.
   */
  async resume(
    id: string,
    claudeSessionId: string,
    message: string,
    fetchBase = false,
  ): Promise<string | null> {
    const refused = this.resumeRefused() ?? this.fetchBaseRefused(fetchBase);
    if (refused !== null) return refused;
    // Assigned in the set-up: a plain `null` would narrow it for good.
    let failure = null as StartFailure | null;
    const answer = await this.setUp(async () => {
      if (fetchBase) {
        const failed = await this.fetchBase();
        if (failed !== null) return failed;
        const meanwhile = this.resumeRefused();
        if (meanwhile !== null) return meanwhile;
      }
      this.data.claudeSessionId = claudeSessionId;
      this.remember(id);
      this.save();
      failure = await this.launch(message, claudeSessionId);
      return null;
    });
    if (failure) await this.end(failure.reason, failure.detail);
    return answer;
  }

  /** Whether the `run.input` or `run.resume` of this id was given already (lot 3 step G2b). */
  delivered(id: string): boolean {
    return this.data.deliveredIds.includes(id);
  }

  /** Keeps a delivered message's id, saved by the caller with what it delivers. */
  private remember(id: string): void {
    this.data.deliveredIds = [...this.data.deliveredIds, id].slice(-DELIVERED_IDS_KEPT);
  }

  /**
   * Only a run waiting for CI takes `fetchBase` (05, section 4.9): a credentialed download runs
   * only where a conflict's message needs it, never for another message (lot 3 step G2b).
   */
  private fetchBaseRefused(fetchBase: boolean): string | null {
    if (!fetchBase || this.data.state === 'waiting_ci') return null;
    return 'Only a run waiting for CI downloads its base branch.';
  }

  /** Why a `run.input` cannot be taken now; null when it can. */
  private inputRefused(): string | null {
    if (this.ended || this.ending) return 'The run has ended.';
    if (!this.sessionAlive && CLOSED_STATES.includes(this.data.state)) {
      return SESSION_CLOSED_REFUSAL;
    }
    return null;
  }

  /** Why a `run.resume` cannot be taken now; null when it can. */
  private resumeRefused(): string | null {
    if (this.ended || this.ending) return 'The run has ended.';
    if (this.sessionAlive) return SESSION_ALIVE_REFUSAL;
    if (!this.data.worktree) return "The run's workspace is not on this machine any more.";
    return null;
  }

  /**
   * Downloads the base branch before a conflict's message (lot 3 step G2a); the masked reason
   * when it failed, null when done.
   */
  private async fetchBase(): Promise<string | null> {
    const { bare } = this.data;
    if (!bare) return "The run's workspace is not on this machine any more.";
    try {
      const folder = createRunFolder(this.context.paths, this.runId);
      await this.context.workspaces.fetchBase(this.data.start, folder, bare);
      return null;
    } catch (error) {
      this.log.warn({ err: error }, 'base branch not downloaded: message refused');
      return cutText(maskSecrets((error as Error).message), TEXT_CEILING, 'end');
    }
  }

  /**
   * `run.stop` (05, section 3.3); `completed` ends a run waiting for CI whose CI passed with
   * `submitted` (05, section 4.9; protocol 2).
   */
  stop(reason: RunStop['payload']['reason']): Promise<void> {
    return this.end(reason === 'completed' ? 'submitted' : 'stopped', null);
  }

  // Timeouts and liveness (05, sections 4.2.1 and 5).

  /** Starts a tick, unless one is in flight or the run is ending or stopped. */
  private tick(): void {
    if (this.ticking || this.ending || this.stopped) return;
    this.ticking = true;
    this.background('tick', async () => {
      try {
        await this.checkLimits();
      } finally {
        this.ticking = false;
      }
    });
  }

  /** The daemon stopped during an `await` of a tick: this object no longer acts. */
  private stoppedMeanwhile(): boolean {
    return this.stopped;
  }

  /** One tick: the log sent, `state.json` written, then the timeouts and liveness checked. */
  private async checkLimits(): Promise<void> {
    const now = Date.now();
    if (this.sessionAlive && WORKING.includes(this.data.state)) {
      this.data.workingMs += now - this.lastTick;
    }
    this.lastTick = now;
    await this.readTranscript();
    if (this.stoppedMeanwhile()) return;
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
    if (
      this.sessionAlive &&
      this.messageWaitSince !== null &&
      now - this.messageWaitSince >= limits.sessionStartTimeoutSeconds * second
    ) {
      // The machine's Claude Code, never the agent: not a failed attempt (lot 5 step 5bis E).
      await this.end(
        'launch_failed',
        `Claude Code started but did not take its first message within ${String(limits.sessionStartTimeoutSeconds)} seconds, the "Session start timeout" setting: a startup dialog or a change in Claude Code is suspected. Running it again on this machine will not help until that is fixed, and it is not the ticket's fault.`,
      );
      return;
    }
    if (this.data.workingMs >= limits.maxRunDurationMinutes * 60 * second) {
      await this.end(
        'max_duration',
        `The run worked for ${String(limits.maxRunDurationMinutes)} minutes, the "Longest run" setting.`,
      );
      return;
    }
    if (
      this.data.state === 'waiting_human' &&
      this.data.waitingSince !== null &&
      now - this.data.waitingSince >= limits.waitingRunLifetimeMinutes * 60 * second
    ) {
      // The answer will come with run.resume (05, section 4.8).
      this.log.info('waiting run lifetime reached: session closed until the answer');
      await this.closeSession();
      this.report('waiting_human');
      return;
    }
    if (
      (this.data.state === 'working' || this.data.state === 'idle') &&
      this.toolsRunning.size === 0 &&
      now - this.lastActivity >= limits.idleTimeoutMinutes * 60 * second
    ) {
      // Right after an API error, the idle timeout is a suspected usage limit (05, section 4.10).
      const limit = this.assess({ kind: 'idle_timeout' });
      if (limit) {
        await this.pauseForQuota(limit);
        return;
      }
      await this.end(
        'idle_timeout',
        `No activity from the agent for ${String(limits.idleTimeoutMinutes)} minutes, the "Idle timeout" setting.`,
      );
      return;
    }
    if (this.sessionAlive && !(await this.context.tmux.hasSession(this.name))) {
      if (this.stoppedMeanwhile()) return;
      if (this.data.state === 'waiting_ci') {
        // The work was accepted: the run keeps waiting with its session closed, as a waiting
        // run after its lifetime (lot 3 step G1a, owner's answer 4).
        this.log.warn('Claude Code exited while the run waits for CI: the wait goes on');
        await this.closeSession();
        this.report('waiting_ci');
        return;
      }
      this.sessionAlive = false;
      const refused = this.context.systemd ? this.scopeRefusal() : null;
      if (refused !== null) {
        const failure = this.scopeFailed(refused);
        await this.end(failure.reason, failure.detail);
        return;
      }
      const launchError = this.launchError();
      if (launchError !== null) {
        await this.end(
          'launch_failed',
          `Claude Code was not started: ${launchError}. Running it again on this machine will not help until that is fixed, and it is not the ticket's fault.`,
        );
        return;
      }
      await this.end('crashed', 'Claude Code exited before the end of the run.');
    }
  }

  // End and cleanup (05, section 4.11).

  /**
   * The end (05, section 4.11): the session closed and the run's processes stopped first, so
   * nothing of the run still works in the worktree or holds it; then the branch read (for a review
   * run, whether its head moved), the worktree removed, the bare clone's Git configuration
   * restored, and the best-effort end push; the end is reported last, with the push's result. A
   * slow push only delays the report: the session, the processes and the worktree are gone. A
   * set-up in flight is waited for first: it launches nothing once the end was asked for.
   */
  private end(endReason: RunEndReason, endDetail: string | null): Promise<void> {
    this.ending ??= (async () => {
      let reason = endReason;
      let detail = endDetail;
      // A set-up in flight sees the end and stops before the launch; what it made (a worktree,
      // a session launched meanwhile) is then known here, and closed or removed below.
      await this.settingUp;
      clearInterval(this.timer);
      this.releaseStart?.();
      this.releaseStart = null;
      if (this.sessionAlive) {
        this.sessionAlive = false;
        await this.killSession(`the run ends (${reason})`);
      }
      // Before the worktree is removed: nothing of the run may still work in it.
      await this.stopProcesses();
      await this.readTranscript().catch(() => undefined);
      let branch: BranchReport | null = null;
      let push: PushResult | null = null;
      let headMoved: boolean | null = null;
      let gitConfigRestored: string | null = null;
      const { bare, reviewStart, start } = this.data;
      // Also a folder made by a preparation the daemon stopped in, before it was recorded.
      const worktree = this.data.worktree ?? worktreePath(this.context.paths, this.runId);
      const repository = ticketRepository(start);
      const { workspaces } = this.context;
      const logged =
        <T>(what: string, fallback: T) =>
        (error: unknown): T => {
          this.log.error({ err: error }, what);
          return fallback;
        };
      // A planning run has no ticket branch: no branch report and no push (05, section 4.2).
      if (bare && repository) {
        let reviewed: string | undefined;
        if (start.purpose === 'review' && reviewStart && this.data.worktree) {
          const heads = await workspaces
            .reviewHeads(bare, worktree, repository.ticketBranch, reviewStart)
            .catch(logged('review head not read', { moved: true, head: null }));
          headMoved = heads.moved;
          reviewed = heads.head ?? reviewStart.head;
        }
        branch = await workspaces
          .branchReport(bare, repository, reviewed)
          .catch(logged('branch not read', null));
      }
      await workspaces.remove(bare, worktree).catch(logged('worktree not removed', undefined));
      if (bare && start.repository) {
        gitConfigRestored = await workspaces
          .restoreConfig(bare, start.repository.cloneUrl)
          .catch(logged('Git configuration not restored', null));
        if (gitConfigRestored !== null) {
          this.log.warn({ changes: gitConfigRestored }, "bare clone's Git configuration restored");
        }
        // Best effort: never changes the outcome. A review run never pushes (05, section 4.9).
        if (PUSHING.includes(start.purpose) && reason !== 'submitted') {
          push = await workspaces
            .endPush(start, bare, runFolder(this.context.paths, this.runId))
            .catch(logged('end push not attempted', null));
          if (push) this.log.info({ push }, 'ticket branch pushed at the end of the run');
          // Read again: what the push sent is on GitHub now (lot 3 step D3).
          if (push?.status === 'pushed' && branch) {
            branch = { ...branch, notOnGitHub: await workspaces.notOnGitHub(bare, branch) };
          }
        }
      }
      if (headMoved) {
        reason = 'review_branch_moved';
        detail =
          "The ticket branch's head moved during the review: a review run must not change the branch, so this review does not count.";
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
          detail:
            detail === null ? null : cutText(maskSecrets(detail), END_REPORT_TEXT_MAX_CHARACTERS),
          branch,
          push,
          headMoved,
          movedHead: this.movedHead,
          download: reason === 'download_failed' ? this.download : null,
          gitConfigRestored:
            gitConfigRestored === null
              ? null
              : cutText(gitConfigRestored, END_REPORT_TEXT_MAX_CHARACTERS),
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
    if (this.ended) {
      // The daemon may have stopped during the end: what the session left is stopped now.
      await this.stopProcesses();
      return;
    }
    const alive = await this.context.tmux.hasSession(this.name);
    if (this.data.state === 'preparing') {
      await this.end('crashed', 'The daemon stopped while it prepared the workspace.');
      return;
    }
    if (!alive) {
      if (WORKING.includes(this.data.state)) {
        await this.end('crashed', "Claude Code's session ended while the daemon was stopped.");
      }
      // A waiting or paused run keeps its closed session until run.resume (05, section 4.11);
      // what the closed session left is stopped, in case the daemon stopped while closing it.
      await this.stopProcesses();
      return;
    }
    this.sessionAlive = true;
    this.launchedAt = this.lastActivity = this.lastTick = Date.now();
    // A fresh window for a message not taken yet; a `starting` run opens it at `SessionStart`.
    if (!this.data.messageTaken && this.data.state !== 'starting') {
      this.messageWaitSince = this.launchedAt;
    }
    this.socket = await serveRunSocket(
      runSocketPath(this.context.paths, this.runId),
      (request) => this.onSocket(request),
      this.connections,
    );
    this.startTimer();
    this.log.info({ state: this.data.state }, 'session found again after a daemon restart');
  }

  /**
   * The daemon is stopping: timers and the socket stop, the session keeps running. Resolves once
   * the work in flight (a tick, a turn's end, the start) is over; nothing runs or writes after.
   */
  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    this.releaseSession();
    while (this.inFlight.size > 0) await Promise.all(this.inFlight);
    // An error of the end was reported to whoever asked for it.
    await this.ending?.catch(() => undefined);
    // A launch in flight may have opened them again.
    this.releaseSession();
    // The log collected by the work above goes with the last write.
    this.flushEvents();
  }

  private releaseSession(): void {
    this.releaseStart?.();
    this.releaseStart = null;
    this.socket?.close();
    this.socket = null;
  }
}

/**
 * The decision each accepted tool makes, applied when the turn ends (05, section 4.8). An accepted
 * review decision ends a review run with `submitted` (protocol 2).
 */
const DECISIONS: Partial<Record<McpToolName, 'submitted' | 'gave_up' | 'asked'>> = {
  ticket_submit: 'submitted',
  ticket_give_up: 'gave_up',
  ticket_ask: 'asked',
  // A planning run's question waits as a ticket's does (lot 5 step D2a).
  request_ask: 'asked',
  // An accepted plan ends a planning run as a submission (lot 5 step E1b).
  plan_propose: 'submitted',
  review_approve: 'submitted',
  review_request_changes: 'submitted',
};

function toolKey(input: Record<string, unknown>): string {
  return typeof input.tool_use_id === 'string' ? input.tool_use_id : String(input.tool_name);
}

function ticketOf(start: RunStart['payload']): string | undefined {
  return start.subject.kind === 'ticket' ? start.subject.number : undefined;
}

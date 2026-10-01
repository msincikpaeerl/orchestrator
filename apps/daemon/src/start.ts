import { randomUUID } from 'node:crypto';
import type { Server } from 'node:net';
import { join } from 'node:path';
import {
  PROTOCOL_VERSION,
  type ControlStatus,
  type GitCredential,
  type Hello,
} from '@orchestrator/protocol';
import { requireConfig } from './config.js';
import { ServerConnection, type SocketFactory } from './connection.js';
import type { CredentialSource } from './credentials.js';
import { probeControl, removeStaleControl, serveControl } from './control.js';
import { detectCapabilities, machineOs } from './detect.js';
import { helpLink, runDoctor } from './doctor.js';
import { doctorEnvironment } from './environment.js';
import { EXIT_REFUSED, UserError } from './errors.js';
import { findExecutable } from './exec.js';
import { Git } from './git.js';
import { clearLastStop, writeLastStop, type LastStop } from './last-stop.js';
import { createLogger } from './logger.js';
import type { DaemonPaths } from './paths.js';
import { RunManager } from './runs.js';
import { ProcessScopes } from './scopes.js';
import { selfCommand } from './self.js';
import { ServerCalls } from './server-calls.js';
import { parseServerUrl, webSocketUrl } from './server-url.js';
import { UserSystemd, tmuxScopeName, unitPrefix } from './systemd.js';
import { Tmux } from './tmux.js';
import { TrustRegistry } from './trust.js';
import { DAEMON_VERSION } from './version.js';
import { Workspaces } from './workspace.js';

export interface StartOptions {
  paths: DaemonPaths;
  /** Started by the systemd unit (`start --service`), or typed in a terminal. */
  mode: 'service' | 'terminal';
  socketFactory?: SocketFactory;
}

/** Describes a running daemon for a refusal: "as the service (process 1234)". */
export function describeRunning(status: ControlStatus): string {
  return `${status.mode === 'service' ? 'as the service' : 'in a terminal'} (process ${String(status.pid)})`;
}

/**
 * `orchestrator-daemon start`: runs until stopped. Resolves with the exit code: 0 when stopped
 * by a signal, `EXIT_REFUSED` after a refusal that retrying cannot fix (05, section 3.2).
 */
export async function startDaemon(options: StartOptions): Promise<number> {
  const { paths, mode } = options;
  const config = await requireConfig(paths.config);
  const serverUrl = parseServerUrl(config.serverUrl);

  const probe = await probeControl(paths.controlSocket);
  if (probe.kind === 'running') {
    throw new UserError(
      `A daemon is already running ${describeRunning(probe.status)}: only one runs per user. Type "orchestrator-daemon status" to see it.`,
      EXIT_REFUSED,
    );
  }
  // Left by a daemon that crashed: nothing answers on it.
  if (probe.kind === 'stale') await removeStaleControl(paths.controlSocket);

  const log = createLogger().child({ machine: config.machineName });
  const startedAt = new Date();
  const environment = doctorEnvironment(paths, 'daemon');
  let lastHello: Hello['payload'] | null = null;
  // Set below: the credential source needs the connection, which needs the runs for `hello`.
  let connection: ServerConnection | null = null;

  // The GitHub credential for one Git command, asked from the server (05, section 7). The
  // answer is awaited at most the run's MCP call timeout, the daemon's wait for any answer.
  const credentialAnswers = new Map<string, (answer: GitCredential['payload'] | null) => void>();
  const credentials: CredentialSource = (request) =>
    new Promise((resolve) => {
      const run = runs.get(request.runId);
      if (!run) {
        resolve(null);
        return;
      }
      const id = randomUUID();
      const timeoutSeconds = run.limits.mcpCallTimeoutSeconds;
      const timer = setTimeout(() => {
        credentialAnswers.delete(id);
        log.warn({ runId: request.runId }, 'no Git credential from the Orchestrator in time');
        resolve(null);
      }, timeoutSeconds * 1000);
      credentialAnswers.set(id, (answer) => {
        clearTimeout(timer);
        credentialAnswers.delete(id);
        if (answer && !answer.ok) log.warn({ runId: request.runId }, answer.message);
        resolve(answer?.ok ? { username: answer.username, password: answer.password } : null);
      });
      if (!connection?.sendMessage({ type: 'git.credential_request', id, payload: request })) {
        credentialAnswers.get(id)?.(null);
      }
    });

  // The agents' tool calls (06, section 1).
  const serverCalls = new ServerCalls((message) => connection?.sendMessage(message) ?? false);

  const tools = environment.toolPath;
  const trust = new TrustRegistry(join(paths.claudeConfig, '.claude.json'));
  const self = selfCommand();
  // Where the user's systemd creates scopes (the service's normal case), the tmux server and each
  // run get scopes of their own (05, sections 2 and 4.11). The service needs them: without them it
  // reports an error and starts no session; a daemon in a terminal goes on without them.
  const prefix = unitPrefix(paths);
  const { systemd, problem } = await UserSystemd.detect(tools, process.env, prefix);
  const scopes = new ProcessScopes(
    mode,
    mode === 'service' ? problem : null,
    helpLink(config, 'process-scopes'),
  );
  const runs = new RunManager({
    paths,
    log,
    tmux: new Tmux(
      findExecutable('tmux', tools) ?? 'tmux',
      process.env,
      systemd ? { systemd, unit: tmuxScopeName(prefix) } : null,
    ),
    trust,
    workspaces: new Workspaces({
      paths,
      git: new Git(findExecutable('git', tools) ?? 'git', process.env),
      trust,
      credentials,
      selfCommand: self,
      log,
    }),
    callServer: (call, timeoutSeconds) => serverCalls.call(call, timeoutSeconds),
    selfCommand: self,
    toolPath: tools,
    envCommand: findExecutable('env', tools) ?? '/usr/bin/env',
    secondMs: 1000,
    systemd,
    unitPrefix: prefix,
    scopes,
  });
  if (systemd) log.info('process scopes used');
  else if (scopes.problem)
    log.error({ reason: problem }, 'process scopes cannot be created: no runs');
  else log.warn({ reason: problem }, 'process scopes not used: daemon in a terminal');
  await runs.recover();

  const buildHello = async (): Promise<Hello['payload']> => {
    const doctor = await runDoctor(environment, scopes.check());
    lastHello = {
      protocolVersion: PROTOCOL_VERSION,
      daemonVersion: DAEMON_VERSION,
      claudeCodeVersion: doctor.claudeCodeVersion,
      os: machineOs(environment.wsl),
      capabilities: detectCapabilities(environment.toolPath),
      doctor: doctor.checks,
      runs: runs.list().map(({ runId, state, claudeSessionId }) => ({
        runId,
        state,
        claudeSessionId,
      })),
    };
    const problems = doctor.checks.filter((check) => check.status === 'error');
    if (problems.length > 0) {
      log.warn(
        { problems: problems.map((check) => `${check.name}: ${check.message}`) },
        'checks found errors: the machine gets no runs until they are fixed and the daemon restarted',
      );
    }
    return lastHello;
  };

  let finish: (code: number) => void = () => undefined;
  const finished = new Promise<number>((resolve) => {
    finish = resolve;
  });
  let control: Server | null = null;
  const end = async (stop: LastStop, code: number) => {
    connection?.stop();
    // Sessions keep running; the next start finds them (05, section 6).
    await runs.shutdown();
    await writeLastStop(paths.lastStop, stop);
    control?.close();
    await removeStaleControl(paths.controlSocket);
    finish(code);
  };

  const server = new ServerConnection({
    url: webSocketUrl(serverUrl),
    token: config.machineToken,
    ca: config.ca,
    log,
    hello: buildHello,
    socketFactory: options.socketFactory,
    onWelcome: () => {
      void clearLastStop(paths.lastStop);
      runs.outbox.resend();
    },
    onDisconnected: () => {
      serverCalls.disconnected();
    },
    onMessage: (message) => {
      switch (message.type) {
        case 'ack':
          runs.outbox.ack(
            message.id,
            message.payload.ok,
            message.payload.ok ? null : message.payload.message,
          );
          return;
        case 'git.credential':
          credentialAnswers.get(message.id)?.(message.payload);
          return;
        case 'mcp.result':
          serverCalls.answer(message);
          return;
        default:
          void runs
            .handle(message)
            .then((payload) => server.sendMessage({ type: 'ack', id: message.id, payload }))
            .catch((error: unknown) => {
              // Never an unhandled rejection, which would stop the daemon.
              log.error({ err: error, type: message.type, id: message.id }, 'command failed');
            });
      }
    },
    onRefused: (refusal) => {
      process.stderr.write(`${refusal.message}\n`);
      void end(
        { at: new Date().toISOString(), reason: refusal.reason, message: refusal.message },
        EXIT_REFUSED,
      );
    },
  });

  connection = server;
  runs.outbox.connect((message) => server.sendMessage(message));
  // A run's scope could not be created: the server hears it at once (05, section 3.3). When not
  // connected, the next `hello` carries the same checks.
  scopes.onProblem = () => {
    void buildHello()
      .then(({ doctor }) =>
        server.sendMessage({ type: 'machine.doctor', id: randomUUID(), payload: { doctor } }),
      )
      .catch((error: unknown) => {
        // Never an unhandled rejection, which would stop the daemon.
        log.error({ err: error }, 'checks not sent');
      });
  };

  control = await serveControl(paths.controlSocket, () => ({
    type: 'status',
    mode,
    pid: process.pid,
    startedAt: startedAt.toISOString(),
    serverUrl,
    machineName: config.machineName,
    connection: server.state,
    connectedAt: server.connectedAt?.toISOString() ?? null,
    lastError: server.lastError,
    daemonVersion: DAEMON_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    claudeCodeVersion: lastHello?.claudeCodeVersion ?? null,
    os: lastHello?.os ?? machineOs(environment.wsl),
    capabilities: lastHello?.capabilities ?? [],
    processScopes: scopes.check(),
    runs: runs.list().map(({ runId, state, ticket, repository, branch }) => ({
      runId,
      state,
      ticket,
      repository,
      branch,
    })),
  }));

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      log.info({ signal }, 'stopping');
      void end(
        {
          at: new Date().toISOString(),
          reason: 'stopped',
          message:
            mode === 'service'
              ? 'Stopped (systemctl --user stop orchestrator-daemon, or the computer shut down). Start it with: systemctl --user start orchestrator-daemon'
              : 'Stopped with Ctrl+C or a signal.',
        },
        0,
      );
    });
  }

  log.info({ serverUrl, mode, version: DAEMON_VERSION }, 'daemon started');
  server.start();
  return finished;
}

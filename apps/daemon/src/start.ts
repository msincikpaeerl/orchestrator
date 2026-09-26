import type { Server } from 'node:net';
import { PROTOCOL_VERSION, type ControlStatus, type Hello } from '@orchestrator/protocol';
import { requireConfig } from './config.js';
import { ServerConnection, type SocketFactory } from './connection.js';
import { probeControl, removeStaleControl, serveControl } from './control.js';
import { detectCapabilities, machineOs } from './detect.js';
import { runDoctor } from './doctor.js';
import { doctorEnvironment } from './environment.js';
import { EXIT_REFUSED, UserError } from './errors.js';
import { clearLastStop, writeLastStop, type LastStop } from './last-stop.js';
import { createLogger } from './logger.js';
import type { DaemonPaths } from './paths.js';
import { parseServerUrl, webSocketUrl } from './server-url.js';
import { DAEMON_VERSION } from './version.js';

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

  const buildHello = async (): Promise<Hello['payload']> => {
    const doctor = await runDoctor(environment);
    lastHello = {
      protocolVersion: PROTOCOL_VERSION,
      daemonVersion: DAEMON_VERSION,
      claudeCodeVersion: doctor.claudeCodeVersion,
      os: machineOs(environment.wsl),
      capabilities: detectCapabilities(environment.toolPath),
      doctor: doctor.checks,
      // Runs are started from lot 2 step F on.
      runs: [],
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
    connection.stop();
    await writeLastStop(paths.lastStop, stop);
    control?.close();
    await removeStaleControl(paths.controlSocket);
    finish(code);
  };

  const connection = new ServerConnection({
    url: webSocketUrl(serverUrl),
    token: config.machineToken,
    ca: config.ca,
    log,
    hello: buildHello,
    socketFactory: options.socketFactory,
    onWelcome: () => void clearLastStop(paths.lastStop),
    onRefused: (refusal) => {
      process.stderr.write(`${refusal.message}\n`);
      void end(
        { at: new Date().toISOString(), reason: refusal.reason, message: refusal.message },
        EXIT_REFUSED,
      );
    },
  });

  control = await serveControl(paths.controlSocket, () => ({
    type: 'status',
    mode,
    pid: process.pid,
    startedAt: startedAt.toISOString(),
    serverUrl,
    machineName: config.machineName,
    connection: connection.state,
    connectedAt: connection.connectedAt?.toISOString() ?? null,
    lastError: connection.lastError,
    daemonVersion: DAEMON_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    claudeCodeVersion: lastHello?.claudeCodeVersion ?? null,
    os: lastHello?.os ?? machineOs(environment.wsl),
    capabilities: lastHello?.capabilities ?? [],
    runs: [],
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
  connection.start();
  return finished;
}

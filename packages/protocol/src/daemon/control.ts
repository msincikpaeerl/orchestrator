import { z } from 'zod';
import { Capability, DaemonBuild, DoctorCheck, MachineOs } from './connection.js';
import { TicketReference } from '../api/tickets.js';
import { GitBranchName } from './git.js';
import { DaemonRunState, RunId } from './runs.js';

/**
 * The daemon's control socket, `~/.orchestrator/daemon.sock` (05, section 8): one JSON request
 * per line, one JSON answer per line. No request changes the daemon's state, and no answer holds
 * a token or another secret, since agents run under the same user. `status` reads it;
 * `recheck`, sent by `orchestrator-daemon login` once Claude Code exits, makes the daemon run its
 * checks again and send them to the server (`machine.doctor`) when connected (lot 5 step M2b).
 */
export const ControlRequest = z.discriminatedUnion('type', [
  z.object({ type: z.literal('status') }),
  z.object({ type: z.literal('recheck') }),
]);
export type ControlRequest = z.infer<typeof ControlRequest>;

/** Answer to `recheck`: whether the checks were sent, false while not connected. */
export const ControlRechecked = z.object({ type: z.literal('rechecked'), sent: z.boolean() });
export type ControlRechecked = z.infer<typeof ControlRechecked>;

/** Where the daemon is in its connection to the server (05, section 3.2). */
export const ConnectionState = z.enum([
  /** Opening the WebSocket, or waiting for `welcome`. */
  'connecting',
  /** `welcome` accepted it. */
  'connected',
  /** Waiting before the next attempt (backoff). */
  'waiting',
]);
export type ConnectionState = z.infer<typeof ConnectionState>;

/** Answer to `status`. */
export const ControlStatus = z.object({
  type: z.literal('status'),
  /** Started by the systemd unit, or typed in a terminal (`orchestrator-daemon start`). */
  mode: z.enum(['service', 'terminal']),
  pid: z.int().positive(),
  startedAt: z.iso.datetime(),
  serverUrl: z.string(),
  machineName: z.string(),
  connection: ConnectionState,
  /** Last accepted `welcome`, or null. */
  connectedAt: z.iso.datetime().nullable(),
  /** Why the last attempt failed, while not connected. */
  lastError: z.string().nullable(),
  daemonVersion: z.string(),
  /** Null for a daemon run from its sources. */
  daemonBuild: DaemonBuild.nullable(),
  protocolVersion: z.int().positive(),
  claudeCodeVersion: z.string().nullable(),
  os: MachineOs,
  capabilities: z.array(Capability),
  /**
   * The process scopes check (05, section 8): always for the service, for a daemon in a terminal
   * only once it reports an error. `doctor` typed in a terminal shows it from here.
   */
  processScopes: DoctorCheck.nullable(),
  /**
   * Live runs, each with its ticket (null for a planning run), its repository (`owner/name`, null
   * for a planning run of a new project) and its ticket branch (null for a planning run), so
   * `status` says which local branch a live run uses.
   */
  runs: z.array(
    z.object({
      runId: RunId,
      state: DaemonRunState,
      ticket: TicketReference.nullable(),
      /** The request a planning run plans; null for every other run. */
      request: z.uuid().nullable(),
      repository: z.string().nullable(),
      branch: GitBranchName.nullable(),
    }),
  ),
});
export type ControlStatus = z.infer<typeof ControlStatus>;

import { z } from 'zod';
import { Capability, MachineOs } from './connection.js';
import { DaemonRunState, RunId } from './runs.js';

/**
 * The daemon's control socket, `~/.orchestrator/daemon.sock` (05, section 8): one JSON request
 * per line, one JSON answer per line. It is read-only: no request changes any state, and no
 * answer holds a token or another secret, since agents run under the same user.
 */
export const ControlRequest = z.object({ type: z.literal('status') });
export type ControlRequest = z.infer<typeof ControlRequest>;

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
  protocolVersion: z.int().positive(),
  claudeCodeVersion: z.string().nullable(),
  os: MachineOs,
  capabilities: z.array(Capability),
  runs: z.array(z.object({ runId: RunId, state: DaemonRunState })),
});
export type ControlStatus = z.infer<typeof ControlStatus>;

import { z } from 'zod';
import { BranchDelete, BranchDeleteResult } from './branches.js';
import { Hello, Heartbeat, MachineDoctor, Welcome } from './connection.js';
import { Ack } from './envelope.js';
import { GitCredential, GitCredentialRequest, McpCall, McpResult } from './relay.js';
import {
  RunEvents,
  RunInput,
  RunQuotaLimited,
  RunResume,
  RunStart,
  RunState,
  RunStop,
} from './runs.js';

/** Every message a daemon sends to the server (05, section 3.3). An unknown type is refused. */
export const DaemonMessage = z.discriminatedUnion('type', [
  Hello,
  Heartbeat,
  MachineDoctor,
  Ack,
  RunState,
  RunEvents,
  RunQuotaLimited,
  McpCall,
  GitCredentialRequest,
  BranchDeleteResult,
]);
export type DaemonMessage = z.infer<typeof DaemonMessage>;

/** Every message the server sends to a daemon (05, section 3.3). An unknown type is refused. */
export const ServerMessage = z.discriminatedUnion('type', [
  Welcome,
  Ack,
  RunStart,
  RunInput,
  RunResume,
  RunStop,
  McpResult,
  GitCredential,
  BranchDelete,
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

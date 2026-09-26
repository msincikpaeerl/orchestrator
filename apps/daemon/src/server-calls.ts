import { randomUUID } from 'node:crypto';
import type { McpCall, McpResult } from '@orchestrator/protocol';
import type { McpAnswer } from './run-socket.js';

// The agents' tool calls on their way to the server (06, section 1): each `mcp.call` waits for
// the `mcp.result` with its id at most the run's MCP call timeout. While the daemon is
// disconnected, or when the connection drops during the wait, the call gets `UNAVAILABLE` at
// once; an answer arriving later is ignored.

const RETRY = 'Try again in a few minutes. If it keeps failing, end your turn.';

export function unavailable(message: string): McpAnswer {
  return { ok: false, error: { code: 'UNAVAILABLE', message } };
}

export const DISCONNECTED = unavailable(
  `This machine is not connected to the Orchestrator right now. ${RETRY}`,
);

export class ServerCalls {
  private readonly pending = new Map<string, (answer: McpAnswer) => void>();

  /**
   * `send` returns false when the message could not be sent (not connected). `secondMs`: how
   * long a second of the timeout lasts, shorter in tests.
   */
  constructor(
    private readonly send: (message: McpCall) => boolean,
    private readonly secondMs = 1000,
  ) {}

  call(payload: McpCall['payload'], timeoutSeconds: number): Promise<McpAnswer> {
    const id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        finish(
          unavailable(
            `The Orchestrator did not answer within ${String(timeoutSeconds)} seconds (the "MCP call timeout" setting). ${RETRY}`,
          ),
        );
      }, timeoutSeconds * this.secondMs);
      const finish = (answer: McpAnswer) => {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(answer);
      };
      this.pending.set(id, finish);
      if (!this.send({ type: 'mcp.call', id, payload })) finish(DISCONNECTED);
    });
  }

  /** An `mcp.result` of the server; one for a call no longer waiting is ignored. */
  answer(message: McpResult): void {
    this.pending.get(message.id)?.(message.payload);
  }

  /** The connection dropped: every waiting call gets `UNAVAILABLE`. */
  disconnected(): void {
    for (const finish of [...this.pending.values()]) finish(DISCONNECTED);
  }
}

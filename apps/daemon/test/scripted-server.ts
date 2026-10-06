import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  DaemonMessage,
  PROTOCOL_VERSION,
  type Hello,
  type RunState,
  type ServerMessage,
} from '@orchestrator/protocol';
import { WebSocketServer, type WebSocket } from 'ws';

// A server speaking the daemon protocol on the WebSocket, for the tests of the daemon process
// (`daemon-runs.test.ts`, `systemd.test.ts`): it welcomes, gives the Git credential, answers tool
// calls as a test says, records everything and acknowledges reports when told to.

export const TOKEN = 'ghp_ScriptedServerToken0123456789abcdefgh';

/** A server speaking the daemon protocol: welcomes, records, acknowledges when told to. */
export class ScriptedServer {
  received: DaemonMessage[] = [];
  acknowledge = true;
  /** Refuses the credential of a push (a run's end push), so commits stay on the machine. */
  refusePush = false;
  /** What to do with each next `mcp.call`: answer it, never answer, or drop the connection. */
  mcpScript: ('answer' | 'silent' | 'drop')[] = [];
  private socket: WebSocket | null = null;
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  url = '';

  constructor() {
    this.http = createServer();
    this.wss = new WebSocketServer({ server: this.http, path: '/daemon' });
    this.wss.on('connection', (socket) => {
      this.socket = socket;
      socket.on('message', (data: Buffer) => {
        const message = DaemonMessage.parse(JSON.parse(data.toString('utf8')));
        this.received.push(message);
        this.answer(socket, message);
      });
    });
  }

  private answer(socket: WebSocket, message: DaemonMessage): void {
    const send = (answer: ServerMessage) => {
      socket.send(JSON.stringify(answer));
    };
    switch (message.type) {
      case 'hello':
        send({
          type: 'welcome',
          id: message.id,
          payload: {
            accepted: true,
            protocolVersion: PROTOCOL_VERSION,
            heartbeatIntervalSeconds: 5,
          },
        });
        return;
      case 'git.credential_request':
        send({
          type: 'git.credential',
          id: message.id,
          payload:
            this.refusePush && message.payload.command === 'push'
              ? { ok: false, message: 'refused by the test' }
              : { ok: true, username: 'x-access-token', password: TOKEN },
        });
        return;
      case 'mcp.call': {
        const action = this.mcpScript.shift() ?? 'answer';
        if (action === 'answer') {
          send({
            type: 'mcp.result',
            id: message.id,
            payload: { ok: true, output: { tool: message.payload.tool } },
          });
        } else if (action === 'drop') socket.terminate();
        return;
      }
      case 'run.state':
      case 'run.events':
      case 'run.quota_limited':
      case 'machine.doctor':
        if (this.acknowledge) send({ type: 'ack', id: message.id, payload: { ok: true } });
        return;
      default:
    }
  }

  send(message: ServerMessage): void {
    this.socket?.send(JSON.stringify(message));
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.http.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${String((this.http.address() as AddressInfo).port)}`;
  }

  hellos(): Hello[] {
    return this.received.filter((message): message is Hello => message.type === 'hello');
  }

  states(runId: string): RunState[] {
    return this.received.filter(
      (message): message is RunState =>
        message.type === 'run.state' && message.payload.runId === runId,
    );
  }

  async close(): Promise<void> {
    for (const client of this.wss.clients) client.terminate();
    this.wss.close();
    await new Promise((resolve) => this.http.close(resolve));
  }
}

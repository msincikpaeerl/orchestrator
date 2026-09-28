import { STREAM_PATH, StreamMessage } from '@orchestrator/protocol';

// A browser's side of the realtime stream for tests (lot 2 step L): it opens `GET /api/stream`
// with a session cookie and records what the server sends, as an `EventSource` would read it.

export class StreamClient {
  /** The `data` of each event, validated with its schema. */
  readonly messages: StreamMessage[] = [];
  /** Comment lines (the keep-alive) and the `retry` field. */
  readonly comments: string[] = [];
  retryMs: number | null = null;
  /** Resolves when the server ends the stream. */
  readonly ended: Promise<void>;
  private waiters: (() => void)[] = [];
  private done = false;

  private constructor(
    private readonly response: Response,
    private readonly abort: AbortController,
  ) {
    this.ended = this.read().finally(() => {
      this.done = true;
      this.wake();
    });
  }

  /** Opens the stream; throws with the status when the server refuses it. */
  static async open(url: string, cookie: string): Promise<StreamClient> {
    const abort = new AbortController();
    const response = await fetch(`${url}${STREAM_PATH}`, {
      headers: { cookie, accept: 'text/event-stream' },
      signal: abort.signal,
    });
    if (response.status !== 200) throw new Error(`stream refused: ${String(response.status)}`);
    return new StreamClient(response, abort);
  }

  get contentType(): string | null {
    return this.response.headers.get('content-type');
  }

  private async read(): Promise<void> {
    if (!this.response.body) return;
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of this.response.body) {
        buffer += decoder.decode(chunk as Uint8Array, { stream: true });
        let end = buffer.indexOf('\n\n');
        while (end !== -1) {
          this.handle(buffer.slice(0, end));
          buffer = buffer.slice(end + 2);
          end = buffer.indexOf('\n\n');
        }
        this.wake();
      }
    } catch (error) {
      if (!this.abort.signal.aborted) throw error;
    }
  }

  private handle(block: string) {
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) this.comments.push(line.slice(1).trim());
      else if (line.startsWith('retry: ')) this.retryMs = Number(line.slice(7));
      else if (line.startsWith('data: ')) {
        this.messages.push(StreamMessage.parse(JSON.parse(line.slice(6))));
      }
    }
  }

  private wake() {
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  /** Waits for the first message `match` accepts, naming `what` when the deadline passes. */
  async find<T extends StreamMessage>(
    match: (message: StreamMessage) => message is T,
    what: string,
    timeoutMs = 5000,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.find(match);
      if (found) return found;
      if (this.done) throw new Error(`stream ended before ${what}`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no ${what} within ${String(timeoutMs)} ms`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /** Waits until the server ends the stream. */
  async end(what: string, timeoutMs = 5000): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.ended,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${what}: the stream did not end within ${String(timeoutMs)} ms`));
        }, timeoutMs);
      }),
    ]).finally(() => {
      clearTimeout(timer);
    });
  }

  close(): void {
    this.abort.abort();
  }
}

import { afterEach, describe, expect, it } from 'vitest';
import { connectStream, handleStreamMessage } from './live';
import { keys, queryClient } from './queries';

/** Stands in for the browser's EventSource: the test opens it by hand. */
class FakeEventSource {
  static readonly CLOSED = 2;
  static last: FakeEventSource | null = null;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
}

function source(): FakeEventSource {
  if (!FakeEventSource.last) throw new Error('no stream opened');
  return FakeEventSource.last;
}

const stale = () => queryClient.getQueryState(keys.projects)?.isInvalidated;

afterEach(() => {
  queryClient.clear();
  FakeEventSource.last = null;
});

describe('connectStream', () => {
  // A change between a screen's first read and the stream's opening reaches no stream: the screen
  // showed it only at the next change. It failed an end-to-end test in CI (lot 3 step H5).
  it('reads the screens again when the stream opens the first time', () => {
    queryClient.setQueryData(keys.projects, []);
    const close = connectStream(FakeEventSource as unknown as typeof EventSource);
    expect(stale()).toBe(false);
    source().onopen?.();
    expect(stale()).toBe(true);
    close();
  });

  it('reads the screens again after a reconnection', () => {
    const close = connectStream(FakeEventSource as unknown as typeof EventSource);
    source().onopen?.();
    queryClient.setQueryData(keys.projects, []);
    source().onopen?.();
    expect(stale()).toBe(true);
    close();
  });
});

describe('handleStreamMessage', () => {
  it("reads the queue again at a request's change: its planning is a line (lot 5 step E2b)", () => {
    queryClient.setQueryData(keys.queue, { at: '', accounts: [], candidates: [] });
    handleStreamMessage({ type: 'changed', entity: 'request', id: null, project: null });
    expect(queryClient.getQueryState(keys.queue)?.isInvalidated).toBe(true);
  });
});

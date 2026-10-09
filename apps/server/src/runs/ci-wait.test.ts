import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PollLoop } from './ci-wait.js';

// The loop of the CI checks (lot 3 step G1a), on a clock the test moves: every GitHub check
// interval, read again each time; never two ticks at once; held back until GitHub's reset time.

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-10-09T10:00:00.000Z') });
});

afterEach(() => {
  vi.useRealTimers();
});

function loop(options: { intervalSeconds: () => number; work: () => Promise<void> }) {
  return new PollLoop({
    intervalMs: () => Promise.resolve(options.intervalSeconds() * 1000),
    work: options.work,
    log: { error: vi.fn() },
    now: () => Date.now(),
  });
}

describe('the CI checks loop', () => {
  it('ticks at once, then every interval, reading the interval again each time', async () => {
    let interval = 60;
    const ticks: number[] = [];
    const poll = loop({
      intervalSeconds: () => interval,
      work: () => {
        ticks.push(Date.now());
        return Promise.resolve();
      },
    });
    poll.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(ticks).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(ticks).toHaveLength(1);
    interval = 15;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ticks).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(ticks).toHaveLength(3);
    await poll.close();
  });

  it('never runs two ticks at once: a slow one delays the next', async () => {
    let running = 0;
    let most = 0;
    let release: () => void = () => undefined;
    const poll = loop({
      intervalSeconds: () => 15,
      work: async () => {
        running += 1;
        most = Math.max(most, running);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        running -= 1;
      },
    });
    poll.start();
    await vi.advanceTimersByTimeAsync(0);
    // A tick asked by hand while the first is in flight waits for it.
    const asked = poll.tick();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(most).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    release();
    await asked;
    expect(most).toBe(1);
    const closed = poll.close();
    release();
    await closed;
  });

  it('waits for the time GitHub gives after its request limit', async () => {
    const ticks: number[] = [];
    const poll: PollLoop = loop({
      intervalSeconds: () => 60,
      work: () => {
        ticks.push(Date.now());
        if (ticks.length === 1) poll.pauseUntil(Date.now() + 10 * 60_000);
        return Promise.resolve();
      },
    });
    poll.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(ticks).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ticks).toHaveLength(2);
    expect((ticks[1] ?? 0) - (ticks[0] ?? 0)).toBe(10 * 60_000);
    await poll.close();
  });

  it('goes on after a tick that threw', async () => {
    let calls = 0;
    const poll = loop({
      intervalSeconds: () => 15,
      work: () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error('database down')) : Promise.resolve();
      },
    });
    poll.start();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(calls).toBe(2);
    await poll.close();
  });
});

import { describe, expect, it } from 'vitest';
import { ciCancelledText, machineFailuresText } from './machine-failures-text';

const ticket = { projectKey: 'WEB', number: 12, title: 'Contact form' };
const machine = { id: '6a1e0e8c-1111-4000-8000-000000000000', name: 'Laptop' };
const runId = '3f1e0e8c-3333-4000-8000-000000000000';

describe('the blocking items of lot 4 step D2b', () => {
  it('says CI was cancelled because the branch changed, and that Run now continues', () => {
    const text = ciCancelledText({
      type: 'ci_cancelled',
      ticket,
      runId,
      machine,
      since: '2026-10-20T08:00:00.000Z',
    });
    expect(text.title).toBe('CI cancelled for WEB-12: Contact form');
    expect(text.detail).toBe(
      'CI was cancelled on GitHub because the branch changed there, so the run on Laptop ended. It does not count as a failed attempt. The scheduler does not start WEB-12 by itself until you use Run now: the next run takes the branch as it is on GitHub.',
    );
  });

  it('names the machine, each failure and the setting', () => {
    const text = machineFailuresText({
      type: 'machine_failures',
      ticket,
      machine,
      failures: [
        { cause: 'dispatch_timeout', at: '2026-10-20T08:00:00.000Z', runId },
        { cause: 'machine_problem', at: '2026-10-20T09:00:00.000Z', runId },
      ],
      limit: 2,
      since: '2026-10-20T09:00:00.000Z',
    });
    expect(text.title).toBe('WEB-12 could not start on Laptop');
    expect(text.detail).toBe(
      "Its last 2 runs on Laptop failed because of the machine, not because of the ticket's work. Machine failures before asking you is 2, so the scheduler no longer starts WEB-12 by itself. Check the machine on its page, then use Run now: it starts on any machine that can take the run.",
    );
    expect(text.failures).toHaveLength(2);
    expect(text.failures[0]).toMatch(/: the machine did not confirm the start in time$/);
    expect(text.failures[1]).toMatch(/: the machine could not start Claude Code$/);
  });

  it('says "its run" when the setting is 1', () => {
    const text = machineFailuresText({
      type: 'machine_failures',
      ticket,
      machine,
      failures: [{ cause: 'machine_offline', at: '2026-10-20T08:00:00.000Z', runId }],
      limit: 1,
      since: '2026-10-20T08:00:00.000Z',
    });
    expect(text.detail).toMatch(/^Its run on Laptop failed because of the machine/);
  });
});

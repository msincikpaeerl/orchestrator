import { readFileSync } from 'node:fs';
import { StatusLineInput } from '@orchestrator/protocol';
import { describe, expect, it } from 'vitest';
import { assessTurn, loginError, parseResetTime, type TurnEnd } from './usage-limit.js';

// The usage-limit module against its fixtures (05, section 4.10). Local times keep the cases
// true in any time zone.

interface Window {
  used_percentage: number;
  resetsAtLocal: string;
}
interface Case {
  name: string;
  now: string;
  end: TurnEnd;
  toolUsed?: boolean;
  transcriptApiError?: string;
  statusLine?: { five_hour?: Window; seven_day?: Window };
  expect: {
    kind: 'detected' | 'suspected';
    resetsAt?: string | null;
    signal?: string;
    error?: string | null;
    window?: string;
  } | null;
}

const fixtures = JSON.parse(
  readFileSync(new URL('../test/fixtures/usage-limit/documented.json', import.meta.url), 'utf8'),
) as { cases: Case[] };

const seconds = (local: string) => new Date(local).getTime() / 1000;

function statusLine(input: Case['statusLine']) {
  if (!input) return null;
  const windows = Object.fromEntries(
    Object.entries(input).map(([name, window]) => [
      name,
      { used_percentage: window.used_percentage, resets_at: seconds(window.resetsAtLocal) },
    ]),
  );
  return StatusLineInput.parse({ cost: { total_cost_usd: 1.5 }, rate_limits: windows });
}

describe('usage-limit detection (fixtures from the documentation)', () => {
  it.each(fixtures.cases.map((each) => [each.name, each] as const))('%s', (_name, fixture) => {
    const result = assessTurn({
      end: fixture.end,
      toolUsed: fixture.toolUsed ?? false,
      transcriptApiError: fixture.transcriptApiError ?? null,
      statusLine: statusLine(fixture.statusLine),
      now: new Date(fixture.now),
    });
    const expected = fixture.expect;
    if (expected === null) {
      expect(result).toBeNull();
      return;
    }
    expect(result?.kind).toBe(expected.kind);
    if (expected.resetsAt !== undefined && result?.kind === 'detected') {
      expect(result.resetsAt).toBe(
        expected.resetsAt === null ? null : new Date(expected.resetsAt).toISOString(),
      );
    }
    if (expected.signal) expect(result?.evidence.signal).toBe(expected.signal);
    if (expected.error !== undefined) expect(result?.evidence.error).toBe(expected.error);
    if (expected.window) expect(result?.evidence.statusLine?.window).toBe(expected.window);
  });

  it('keeps the error text as evidence', () => {
    const result = assessTurn({
      end: { kind: 'stop_failure', error: 'overloaded', message: 'API Error: Overloaded' },
      toolUsed: false,
      transcriptApiError: null,
      statusLine: null,
      now: new Date(),
    });
    expect(result?.evidence).toEqual({
      signal: 'stop_failure',
      error: 'overloaded',
      message: 'API Error: Overloaded',
      statusLine: null,
    });
  });
});

describe("Claude Code's login error (lot 5 step M2b)", () => {
  /** The owner's run, lot 5 step M: the agent line of the run's log. */
  const LOGIN = 'Login expired · Please run /login';
  const facts = (end: TurnEnd, transcriptApiError: string | null = null, toolUsed = false) => ({
    end,
    toolUsed,
    transcriptApiError,
    statusLine: null,
    now: new Date('2026-11-03T10:00:00'),
  });

  it.each([
    [
      'a StopFailure authentication_failed with the login text',
      facts({ kind: 'stop_failure', error: 'authentication_failed', message: LOGIN }),
      LOGIN,
    ],
    [
      'a StopFailure authentication_failed without a text',
      facts({ kind: 'stop_failure', error: 'authentication_failed', message: null }),
      null,
    ],
    [
      'a StopFailure of another type with the login text',
      facts({ kind: 'stop_failure', error: 'unknown', message: LOGIN }),
      LOGIN,
    ],
    [
      'an API-error turn whose transcript entry has the login text',
      facts({ kind: 'stop', message: LOGIN }, LOGIN),
      LOGIN,
    ],
    [
      'an idle timeout after the login text in the transcript',
      facts({ kind: 'idle_timeout' }, LOGIN),
      LOGIN,
    ],
    [
      'an invalid key',
      facts({ kind: 'stop', message: null }, 'Invalid API key · Please run /login'),
      'Invalid API key · Please run /login',
    ],
  ])('is %s, and neither a detected nor a suspected limit', (_name, turn, message) => {
    expect(loginError(turn)).toEqual({ message });
    expect(assessTurn(turn)).toBeNull();
  });

  it("is never the agent's own words after a Stop, its tool output or its files", () => {
    // A ticket about a login page: the agent's last message says it, with no API-error mark.
    const said = 'The page now says "Session over · Please run /login" when the token is gone.';
    for (const turn of [
      facts({ kind: 'stop', message: said }),
      facts({ kind: 'stop', message: said }, null, true),
    ]) {
      expect(loginError(turn)).toBeNull();
      expect(assessTurn(turn)).toBeNull();
    }
  });

  it('leaves a rate limit and an overload as they were', () => {
    const limit = "You've hit your session limit · resets 3:45pm";
    expect(
      loginError(facts({ kind: 'stop_failure', error: 'rate_limit', message: limit })),
    ).toBeNull();
    expect(
      assessTurn(facts({ kind: 'stop_failure', error: 'rate_limit', message: limit }))?.kind,
    ).toBe('detected');
    const overload = facts({
      kind: 'stop_failure',
      error: 'overloaded',
      message: 'API Error: Overloaded',
    });
    expect(loginError(overload)).toBeNull();
    expect(assessTurn(overload)?.kind).toBe('suspected');
    const rateLimited = facts({
      kind: 'stop_failure',
      error: 'rate_limit',
      message: 'API Error: Rate limited',
    });
    expect(loginError(rateLimited)).toBeNull();
    expect(assessTurn(rateLimited)?.kind).toBe('suspected');
  });
});

describe('reset time in a message', () => {
  const now = new Date('2026-09-26T10:00:00');
  it('reads 12-hour and 24-hour times, and weekdays', () => {
    expect(parseResetTime('resets 12:00am', now)).toEqual(new Date('2026-09-27T00:00:00'));
    expect(parseResetTime('resets 12pm', now)).toEqual(new Date('2026-09-26T12:00:00'));
    expect(parseResetTime('resets 18:30', now)).toEqual(new Date('2026-09-26T18:30:00'));
    // The same weekday, time passed: next week.
    expect(parseResetTime('resets Sat 9:00am', now)).toEqual(new Date('2026-10-03T09:00:00'));
    expect(parseResetTime('resets Saturday 11am', now)).toEqual(new Date('2026-09-26T11:00:00'));
  });

  it('gives nothing without a readable time', () => {
    expect(parseResetTime('no time here', now)).toBeNull();
    expect(parseResetTime('resets 13pm', now)).toBeNull();
    expect(parseResetTime('resets 25:00', now)).toBeNull();
  });
});

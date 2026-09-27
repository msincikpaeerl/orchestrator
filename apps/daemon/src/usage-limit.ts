import {
  StopFailureError,
  TEXT_CEILING,
  type QuotaEvidence,
  type StatusLineInput,
} from '@orchestrator/protocol';

// Usage-limit detection (05, section 4.10), in one module: it takes the facts of a turn's end
// (hooks, the transcript's API-error mark, the latest status line input) and answers `detected`
// with the reset time when known, `suspected`, or nothing. What it recognises is the data below,
// checked by fixtures (`test/fixtures/usage-limit/`): adjusting detection changes data, not logic.

/**
 * Known usage-limit messages. Source: Claude Code's documentation for 2.1.282 (lot 2 plan,
 * documentation check): "You've hit your session limit · resets 3:45pm", and the same with the
 * weekly, Opus and Sonnet limits. Not yet observed on a real limit (05, section 9).
 */
export const USAGE_LIMIT_PATTERNS: readonly RegExp[] = [
  /you['’]ve hit your (?:session|weekly|opus|sonnet) limit/i,
];

/** API error texts, as Claude Code shows them as a turn's text. */
export const API_ERROR_PATTERNS: readonly RegExp[] = [/^\s*API Error\b/i];

/** The reset time in a usage-limit message: `resets 3:45pm`, `resets Mon 12:00am`. */
export const RESET_PATTERN =
  /resets\s+(?:(mon|tue|wed|thu|fri|sat|sun)[a-z]*\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i;

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** How a turn ended, or the idle timeout that stopped waiting for it. */
export type TurnEnd =
  | { kind: 'stop_failure'; error: string | null; message: string | null }
  | { kind: 'stop'; message: string | null }
  | { kind: 'idle_timeout' };

export interface TurnFacts {
  end: TurnEnd;
  /** A `PreToolUse` was seen during the turn. */
  toolUsed: boolean;
  /** The turn's last assistant entry in the transcript is marked `isApiErrorMessage`. */
  transcriptApiError: string | null;
  /** The latest status line input of the run, if any (supplementary). */
  statusLine: StatusLineInput | null;
  now: Date;
}

export type Assessment =
  | { kind: 'detected'; resetsAt: string | null; evidence: QuotaEvidence }
  | { kind: 'suspected'; evidence: QuotaEvidence }
  | null;

type Window = NonNullable<QuotaEvidence['statusLine']>;

const matches = (patterns: readonly RegExp[], text: string | null) =>
  text !== null && patterns.some((pattern) => pattern.test(text));

/** The status line windows, with the full ones first, the later reset first. */
function windows(input: StatusLineInput | null, now: Date): { all: Window[]; full: Window[] } {
  const all: Window[] = [];
  for (const window of ['five_hour', 'seven_day'] as const) {
    const data = input?.rate_limits?.[window];
    if (data?.used_percentage === undefined) continue;
    const resetsAt =
      data.resets_at === undefined ? null : new Date(data.resets_at * 1000).toISOString();
    all.push({ window, usedPercentage: data.used_percentage, resetsAt });
  }
  // Full: at 100 % with a reset still to come, so an old reading is ignored.
  const full = all
    .filter((w) => w.usedPercentage >= 100 && w.resetsAt !== null && Date.parse(w.resetsAt) > +now)
    .sort((a, b) => Date.parse(b.resetsAt ?? '') - Date.parse(a.resetsAt ?? ''));
  return { all, full };
}

/**
 * The reset time of a message, as the machine's local wall-clock time: the next time it is that
 * time (tomorrow when it has passed today), or the next such weekday (05, section 4.10).
 */
export function parseResetTime(message: string, now: Date): Date | null {
  const match = RESET_PATTERN.exec(message);
  if (!match) return null;
  const [, weekday, hourText = '', minuteText, meridiem] = match;
  let hour = Number(hourText);
  const minute = minuteText === undefined ? 0 : Number(minuteText);
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem.toLowerCase() === 'pm' ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return null;
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute);
  if (weekday) {
    const target = WEEKDAYS.indexOf(weekday.slice(0, 3).toLowerCase());
    let days = (target - at.getDay() + 7) % 7;
    if (days === 0 && at <= now) days = 7;
    at.setDate(at.getDate() + days);
  } else if (at <= now) {
    at.setDate(at.getDate() + 1);
  }
  return at;
}

const clip = (text: string | null) => (text === null ? null : text.slice(0, TEXT_CEILING));

/** Detects or suspects a usage limit at the end of a turn (05, section 4.10). */
export function assessTurn(facts: TurnFacts): Assessment {
  const { end, now } = facts;
  const status = windows(facts.statusLine, now);
  const evidenceWindow =
    status.full[0] ?? status.all.sort((a, b) => b.usedPercentage - a.usedPercentage)[0] ?? null;
  const message =
    end.kind === 'idle_timeout'
      ? facts.transcriptApiError
      : (end.message ?? facts.transcriptApiError);
  const signal: QuotaEvidence['signal'] =
    end.kind === 'stop_failure'
      ? 'stop_failure'
      : end.kind === 'stop'
        ? 'api_error_turn'
        : 'idle_after_api_error';
  const evidence: QuotaEvidence = {
    signal,
    error:
      end.kind === 'stop_failure'
        ? StopFailureError.catch('unknown').parse(end.error ?? 'unknown')
        : null,
    message: clip(message),
    statusLine: evidenceWindow,
  };

  const known = matches(USAGE_LIMIT_PATTERNS, message);
  const rateLimitWhileFull =
    end.kind === 'stop_failure' && end.error === 'rate_limit' && status.full.length > 0;
  if (end.kind !== 'idle_timeout' && (known || rateLimitWhileFull)) {
    const fromMessage = message === null ? null : parseResetTime(message, now);
    return {
      kind: 'detected',
      resetsAt: status.full[0]?.resetsAt ?? fromMessage?.toISOString() ?? null,
      evidence,
    };
  }
  switch (end.kind) {
    case 'stop_failure':
      // Any other API error: an overload or a network error must never lock the account.
      return { kind: 'suspected', evidence };
    case 'stop': {
      const apiError =
        facts.transcriptApiError !== null || matches(API_ERROR_PATTERNS, end.message);
      return apiError && !facts.toolUsed ? { kind: 'suspected', evidence } : null;
    }
    case 'idle_timeout':
      return facts.transcriptApiError !== null ? { kind: 'suspected', evidence } : null;
  }
}

import { maskSecrets } from '@orchestrator/protocol';

// The part of a GitHub Actions job log that belongs to each failed step (lot 3, after the owner's
// third smoke run; plan, step E2 fixes). The end of a failed job's log is the clean-up of its post
// steps, not the failure, so the excerpt an agent gets is cut by step. Measured on a real log
// (test/fixtures/github-job-log/):
//
// - every line starts with a timestamp with seven decimals and a space (`2026-10-06T18:12:12.7117632Z
//   ##[error]…`); an empty output line is the timestamp alone, with or without the space;
// - the log does not name the workflow's steps: "Check documentation links" appears as
//   `##[group]Run npm install …`; a step's own section opens with `##[group]` (not "Set up job",
//   a post step or "Complete job");
// - a failed step's section ends with a `##[error]` line (`Process completed with exit code 1.`);
// - GitHub gives step times in whole seconds, and the post steps run in the same second as the
//   failure: a time window alone ends in the clean-up, a `##[error]` alone cannot tell which step;
// - output carries terminal colour codes; a byte order mark may start the file.
//
// So a failed step's excerpt runs from the first `##[group]` line at or after its start time (or
// the first line at or after it) to its last `##[error]` line before its end time plus one second,
// keeping the end, on whole lines, without timestamps or colour codes, secrets masked. When that
// cut is impossible, the excerpt is the end of the job's log, and says why.

/** A failed step as the jobs answer gives it. */
export interface FailedStep {
  name: string;
  /** Whole seconds, ISO 8601; null when GitHub gives none. */
  startedAt: string | null;
  completedAt: string | null;
}

export type StepExcerpt =
  /** The step's own part of the log, up to its last `##[error]` line. */
  | { step: string; cut: 'step'; text: string; truncated: boolean }
  /**
   * The end of the job's log instead: `reason` says why the step's part could not be cut.
   * `readToEnd` is false when only the first **Longest CI log read** of a larger log was read.
   */
  | {
      step: string;
      cut: 'job';
      reason: string;
      readToEnd: boolean;
      text: string;
      truncated: boolean;
    };

/** What the log was made of: printed by the owner's smoke script (A13). */
export interface JobLogFacts {
  lines: number;
  /** Lines starting with a timestamp. */
  timestamped: number;
  groups: number;
  errors: number;
  byteOrderMark: boolean;
  /** Escape characters (`\x1b`, which starts each terminal colour code). */
  escapes: number;
}

export interface JobLogReading {
  excerpts: StepExcerpt[];
  facts: JobLogFacts;
}

/** How a download of the log ended: at its end, stopped as nothing more was needed, or at the ceiling. */
export type LogEnd = 'end' | 'enough' | 'ceiling';

const TIMESTAMP = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)(?: |$)/;
// eslint-disable-next-line no-control-regex -- the escape character starts every colour code
const COLOUR = /\x1b\[[0-9;]*[A-Za-z]/g;
// eslint-disable-next-line no-control-regex -- counted, for the owner's check
const ESCAPE = /\x1b/g;

/** The last lines of a text, at most `max` characters, whole lines except a single long one. */
class Tail {
  private lines: string[] = [];
  private size = 0;
  truncated = false;

  constructor(private readonly max: number) {}

  add(line: string): void {
    this.lines.push(line);
    this.size += line.length + 1;
    while (this.size > this.max + 1 && this.lines.length > 1) {
      this.size -= (this.lines.shift() ?? '').length + 1;
      this.truncated = true;
    }
  }

  reset(): void {
    this.lines = [];
    this.size = 0;
    this.truncated = false;
  }

  text(): { text: string; truncated: boolean } {
    const text = this.lines.join('\n');
    if (text.length > this.max) return { text: text.slice(-this.max), truncated: true };
    return { text, truncated: this.truncated };
  }
}

interface StepState {
  step: FailedStep;
  /** Milliseconds; null when GitHub gave no time. */
  from: number | null;
  until: number | null;
  section: Tail;
  groupSeen: boolean;
  inWindow: boolean;
  closed: boolean;
  /** The section up to its latest `##[error]` line. */
  cut: { text: string; truncated: boolean } | null;
}

function megabytes(bytes: number): string {
  const value = bytes / 1_048_576;
  return Number.isInteger(value) ? `${String(value)} MB` : `${String(bytes)} bytes`;
}

/**
 * Reads a job's log line by line as it comes (`push`), keeping only what the excerpts need, and
 * gives each failed step's excerpt at the end (`finish`).
 */
export class JobLogReader {
  private readonly states: StepState[];
  private readonly job: Tail;
  private pending = '';
  private lastTime: number | null = null;
  private readonly facts: JobLogFacts = {
    lines: 0,
    timestamped: 0,
    groups: 0,
    errors: 0,
    byteOrderMark: false,
    escapes: 0,
  };

  constructor(
    failedSteps: FailedStep[],
    private readonly options: { maxCharacters: number; maxReadBytes: number },
  ) {
    this.job = new Tail(options.maxCharacters);
    this.states = failedSteps.map((step) => {
      const from = step.startedAt === null ? NaN : Date.parse(step.startedAt);
      const to = step.completedAt === null ? NaN : Date.parse(step.completedAt);
      const timed = !Number.isNaN(from) && !Number.isNaN(to);
      return {
        step,
        from: timed ? from : null,
        // GitHub's step times are whole seconds: the step can end up to a second later.
        until: timed ? to + 1000 : null,
        section: new Tail(options.maxCharacters),
        groupSeen: false,
        inWindow: false,
        closed: false,
        cut: null,
      };
    });
  }

  /** More of the log; false when nothing more is needed (every failed step cut and closed). */
  push(text: string): boolean {
    this.facts.escapes += text.match(ESCAPE)?.length ?? 0;
    const lines = (this.pending + text).split('\n');
    this.pending = lines.pop() ?? '';
    for (const line of lines) this.line(line);
    return (
      this.states.length === 0 || !this.states.every((state) => state.closed && state.cut !== null)
    );
  }

  private line(raw: string): void {
    let line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (this.facts.lines === 0 && line.startsWith('\ufeff')) {
      this.facts.byteOrderMark = true;
      line = line.slice(1);
    }
    this.facts.lines++;
    const stamp = TIMESTAMP.exec(line);
    let content = line;
    if (stamp) {
      const time = Date.parse(stamp[1] ?? '');
      if (!Number.isNaN(time)) {
        this.facts.timestamped++;
        this.lastTime = time;
        content = line.slice(stamp[0].length);
      }
    }
    content = content.replace(COLOUR, '');
    if (content.startsWith('##[group]')) this.facts.groups++;
    const error = content.startsWith('##[error]');
    if (error) this.facts.errors++;
    this.job.add(content);

    const time = this.lastTime;
    if (time === null) return;
    for (const state of this.states) {
      if (state.from === null || state.until === null || state.closed || time < state.from) {
        continue;
      }
      if (time >= state.until) {
        state.closed = true;
        continue;
      }
      // The step's own section opens with its first group; lines before it, in the same second,
      // end the step before.
      if (!state.groupSeen && content.startsWith('##[group]')) {
        state.section.reset();
        state.groupSeen = true;
      }
      state.inWindow = true;
      state.section.add(content);
      if (error) state.cut = state.section.text();
    }
  }

  /** The excerpts, once the download has ended as `end` says. */
  finish(end: LogEnd): JobLogReading {
    // A line cut by the ceiling is not used.
    if (end !== 'ceiling' && this.pending !== '') this.line(this.pending);
    this.pending = '';
    const job = this.job.text();
    const readToEnd = end !== 'ceiling';
    if (this.states.length === 0) {
      const reason = 'GitHub names no failed step in the job';
      return {
        excerpts: [{ step: '', cut: 'job', reason, readToEnd, ...mask(job) }],
        facts: { ...this.facts },
      };
    }
    const excerpts = this.states.map((state): StepExcerpt => {
      const name = state.step.name;
      if (state.cut && (state.closed || end !== 'ceiling')) {
        return { step: name, cut: 'step', ...mask(state.cut) };
      }
      return { step: name, cut: 'job', reason: this.reason(state, end), readToEnd, ...mask(job) };
    });
    return { excerpts, facts: { ...this.facts } };
  }

  private reason(state: StepState, end: LogEnd): string {
    if (state.from === null) return 'GitHub gave no start or end time for the step';
    if (end === 'ceiling') {
      const ceiling = megabytes(this.options.maxReadBytes);
      return `the job's log is larger than Longest CI log read (${ceiling}), and the step's part does not end within its first ${ceiling}`;
    }
    if (this.facts.timestamped === 0) return "the log's lines carry no timestamp";
    if (!state.inWindow) return "no line of the log falls within the step's times";
    return "no ##[error] line falls within the step's times";
  }
}

function mask(part: { text: string; truncated: boolean }): { text: string; truncated: boolean } {
  return { text: maskSecrets(part.text), truncated: part.truncated };
}

/**
 * The line that introduces an excerpt, for an agent or a screen: which step, and, for the
 * fallback, that it is the end of the job's log and why.
 */
export function excerptHeading(excerpt: StepExcerpt): string {
  const cut = excerpt.truncated ? ' (its end only)' : '';
  if (excerpt.cut === 'step') return `Step "${excerpt.step}": its part of the job's log${cut}.`;
  if (excerpt.step === '') {
    return `The job's failed step is not known (${excerpt.reason}). Below is the end of the job's log${cut}.`;
  }
  const what = excerpt.readToEnd
    ? "the end of the whole job's log"
    : "the end of the part of the job's log that was read";
  return `Step "${excerpt.step}": its part of the log could not be cut out (${excerpt.reason}). Below is ${what}${cut}, not the step's part.`;
}

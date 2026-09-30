import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { RunEvents, RunQuotaLimited, RunState, type DaemonMessage } from '@orchestrator/protocol';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { DaemonPaths } from './paths.js';
import { readJson, writeJsonAtomic } from './run-files.js';
import { runFolder } from './run-socket.js';

// The daemon's reports (05, section 3.3): each is kept in its run's `outbox.json` until the
// server acknowledges it, so it survives a daemon restart, and every unacknowledged report is
// sent again, in order, after each reconnection. The server handles duplicates by message id.

export const Report = z.discriminatedUnion('type', [RunState, RunEvents, RunQuotaLimited]);
export type Report = z.infer<typeof Report>;
/** A report before the outbox gives it its id, for each report type. */
type WithoutId<Each> = Each extends unknown ? Omit<Each, 'id'> : never;
type ReportWithoutId = WithoutId<Report>;

export class Outbox {
  private readonly pending = new Map<string, Report[]>();
  private send: ((message: DaemonMessage) => boolean) | null = null;

  constructor(
    private readonly paths: DaemonPaths,
    private readonly log: Logger,
    /** Called when a run's last report is acknowledged. */
    private readonly onDrained: (runId: string) => void = () => undefined,
  ) {}

  private file(runId: string): string {
    return join(runFolder(this.paths, runId), 'outbox.json');
  }

  /**
   * Writes `outbox.json`. A failed write (folder removed, disk full) is logged: the reports stay
   * in memory, are still sent, and the next change writes the file again.
   */
  private save(runId: string): void {
    try {
      writeJsonAtomic(this.file(runId), this.pending.get(runId) ?? []);
    } catch (error) {
      this.log.error({ err: error, runId }, 'outbox.json not written: written at the next change');
    }
  }

  /** Reads the reports a previous daemon left for `runId`. */
  load(runId: string): void {
    const saved = z.array(Report).safeParse(readJson(this.file(runId)));
    if (saved.success && saved.data.length > 0) this.pending.set(runId, saved.data);
  }

  /** Where reports go while connected; returns false when they cannot be sent now. */
  connect(send: (message: DaemonMessage) => boolean): void {
    this.send = send;
  }

  add(runId: string, report: ReportWithoutId): Report {
    const message = { ...report, id: randomUUID() } as Report;
    const reports = this.pending.get(runId) ?? [];
    reports.push(message);
    this.pending.set(runId, reports);
    this.save(runId);
    this.send?.(message);
    return message;
  }

  /** Handles the server's `ack`; returns false for an id it does not hold. */
  ack(id: string, ok: boolean, reason: string | null): boolean {
    for (const [runId, reports] of this.pending) {
      const index = reports.findIndex((report) => report.id === id);
      if (index < 0) continue;
      const [report] = reports.splice(index, 1);
      if (!ok) {
        this.log.warn(
          { runId, type: report?.type, reason },
          'the Orchestrator could not handle a report: dropped',
        );
      }
      if (reports.length === 0) this.pending.delete(runId);
      this.save(runId);
      if (reports.length === 0) this.onDrained(runId);
      return true;
    }
    return false;
  }

  /** Sends every unacknowledged report again, run by run, in order (after `welcome`). */
  resend(): void {
    for (const reports of this.pending.values()) {
      for (const report of reports) {
        if (!this.send?.(report)) return;
      }
    }
  }

  isEmpty(runId: string): boolean {
    return !this.pending.has(runId);
  }
}

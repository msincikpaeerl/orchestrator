import { z } from 'zod';
import { AgentKey } from './agents.js';
import { ProjectKey } from './projects.js';
import { Run, RunLogEntry } from './runs.js';

/**
 * Activity > Live runs (02, section 7): every active run, oldest first, each with its latest log
 * entry, its current activity (owner's decision, lot 2 step L2). The machine pages show the same
 * runs for one machine (02, section 9.2).
 */
export const LiveRun = Run.extend({ latestLog: RunLogEntry.nullable() });
export type LiveRun = z.infer<typeof LiveRun>;

/** `GET /api/runs/live`; `machine` keeps one machine's runs. */
export const LiveRunsQuery = z.object({ machine: z.uuid().optional() });
export const LiveRunsResponse = z.object({ runs: z.array(LiveRun) });
export type LiveRunsResponse = z.infer<typeof LiveRunsResponse>;

/** Display constant: ended runs per page of History (not a setting, 04 section 8). */
export const RUN_HISTORY_PAGE_SIZE = 50;

/** How an ended run ended: the History filter's "outcome" (owner's decision, lot 2 step L2). */
export const RunEndState = z.enum(['succeeded', 'failed', 'cancelled']);
export type RunEndState = z.infer<typeof RunEndState>;

/** The end time and id of the last run shown: `2026-09-24T10:00:00.123456Z_<uuid>`. */
export const RunHistoryCursor = z
  .string()
  .regex(/^\d{4}-\d\d-\d\dT[\d:.]+Z_[0-9a-f-]{36}$/, 'invalid cursor');

/**
 * `GET /api/runs/history`: ended runs, newest end first; every filter is optional. Runs that ended
 * from `from` included to `to` excluded, sent by the screen as the start of the first day chosen
 * and of the day after the last one, as for the event log.
 */
export const RunHistoryQuery = z.object({
  project: ProjectKey.optional(),
  agent: AgentKey.optional(),
  outcome: RunEndState.optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  before: RunHistoryCursor.optional(),
});
export type RunHistoryQuery = z.infer<typeof RunHistoryQuery>;

export const RunHistoryResponse = z.object({
  runs: z.array(Run),
  /** Pass as `before` for the next, older page; null when there is none. */
  next: RunHistoryCursor.nullable(),
});
export type RunHistoryResponse = z.infer<typeof RunHistoryResponse>;

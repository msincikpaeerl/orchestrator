import { RunLogResponse, type RunLogEntry } from '@orchestrator/protocol';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { onReloadAll, onRunLog } from '../live';

/**
 * A run's log, kept up to date (02, sections 1 and 7): the entries after the last one held are
 * fetched when the page opens, at each notice of the stream for this run, after a reconnection
 * and when the window regains focus. Nothing is lost across a reconnection, since the fetch
 * starts from the last entry held, whatever notices were missed.
 */
export function useRunLog(runId: string): { entries: RunLogEntry[]; error: boolean } {
  // The entries held, with the run they belong to: another run's entries are never shown.
  const [held, setHeld] = useState<{ runId: string; entries: RunLogEntry[] }>({
    runId,
    entries: [],
  });
  const [error, setError] = useState(false);

  useEffect(() => {
    let stopped = false;
    // Functions, since `stopped` and `again` change while a fetch is awaited.
    const isStopped = () => stopped;
    let last = -1;
    let busy = false;
    let again = false;
    const askedAgain = () => again;

    // One fetch at a time; a request made meanwhile fetches again once it ends.
    const fetchNew = async () => {
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      try {
        do {
          again = false;
          let more = true;
          while (more && !isStopped()) {
            const page = await api(
              'GET',
              `/api/runs/${encodeURIComponent(runId)}/log?after=${String(last)}`,
              RunLogResponse,
            );
            if (isStopped()) return;
            const lastEntry = page.entries.at(-1);
            if (lastEntry) {
              last = lastEntry.seq;
              setHeld((previous) => ({
                runId,
                entries:
                  previous.runId === runId ? [...previous.entries, ...page.entries] : page.entries,
              }));
            }
            more = page.more;
          }
        } while (askedAgain() && !isStopped());
        setError(false);
      } catch {
        if (!isStopped()) setError(true);
      } finally {
        busy = false;
      }
    };

    void fetchNew();
    const offLog = onRunLog(runId, (seq) => {
      if (seq > last) void fetchNew();
    });
    const offReload = onReloadAll(() => {
      void fetchNew();
    });
    return () => {
      stopped = true;
      offLog();
      offReload();
    };
  }, [runId]);

  return { entries: held.runId === runId ? held.entries : [], error };
}

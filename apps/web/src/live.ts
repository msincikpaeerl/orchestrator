import { STREAM_PATH, STREAM_RETRY_MS, StreamMessage } from '@orchestrator/protocol';
import { useEffect } from 'react';
import { keys, queryClient } from './queries';

// The realtime stream (02, section 1): one Server-Sent Events stream while logged in. A "changed"
// message reloads the screens showing that kind of thing; a run log notice makes the screen
// showing that run fetch its new entries; after a reconnection, everything is read again.

type RunLogListener = (seq: number) => void;
const runLogListeners = new Map<string, Set<RunLogListener>>();
const reloadListeners = new Set<() => void>();

/** Calls `listener` with the last entry number each time the run has new log entries. */
export function onRunLog(runId: string, listener: RunLogListener): () => void {
  let listeners = runLogListeners.get(runId);
  if (!listeners) {
    listeners = new Set();
    runLogListeners.set(runId, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) runLogListeners.delete(runId);
  };
}

/** Calls `listener` whenever the screens read everything again (reconnection, resync, focus). */
export function onReloadAll(listener: () => void): () => void {
  reloadListeners.add(listener);
  return () => reloadListeners.delete(listener);
}

function reloadAll() {
  void queryClient.invalidateQueries();
  for (const listener of reloadListeners) listener();
}

/** The queries showing something of this kind (their keys' prefixes), read again on a change. */
function affected(message: Extract<StreamMessage, { type: 'changed' }>): readonly unknown[][] {
  switch (message.entity) {
    case 'ticket':
    case 'project':
      return [[...keys.projects], [...keys.runs], [...keys.needsYou]];
    case 'run':
      return [[...keys.runs], [...keys.projects], [...keys.needsYou], [...keys.machines]];
    case 'machine':
    case 'claude_account':
      return [[...keys.machines], [...keys.accounts], [...keys.needsYou], [...keys.runs]];
    case 'setting':
      return [[...keys.settings], ['projects', 'settings']];
    case 'github_connection':
      return [[...keys.github], [...keys.setup], [...keys.needsYou]];
    case 'agent_profile':
      return [[...keys.agents]];
    case 'owner':
    case 'session':
      return [[...keys.session]];
  }
}

export function handleStreamMessage(message: StreamMessage) {
  switch (message.type) {
    case 'changed':
      for (const queryKey of affected(message)) void queryClient.invalidateQueries({ queryKey });
      // Every change writes an event: the event log shows it.
      void queryClient.invalidateQueries({ queryKey: ['events'] });
      return;
    case 'run_log':
      for (const listener of runLogListeners.get(message.run) ?? []) listener(message.seq);
      // The run's estimated usage comes with its log entries.
      void queryClient.invalidateQueries({ queryKey: keys.run(message.run) });
      return;
    case 'resync':
      reloadAll();
      return;
  }
}

/**
 * Keeps the stream open while `enabled` (logged in). The browser reconnects a lost stream by
 * itself after the server's delay; a stream it gives up (the server refused it, for example
 * after a logout elsewhere) makes the session be checked, then is opened again after that delay.
 */
export function useLiveStream(enabled: boolean) {
  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return;
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let opened = false;
    let stopped = false;

    const open = () => {
      source = new EventSource(STREAM_PATH);
      source.onopen = () => {
        // The first opening needs no reload: the screens have just read their data.
        if (opened) reloadAll();
        opened = true;
      };
      source.onmessage = (event: MessageEvent<string>) => {
        let data: unknown;
        try {
          data = JSON.parse(event.data);
        } catch {
          return;
        }
        const parsed = StreamMessage.safeParse(data);
        if (parsed.success) handleStreamMessage(parsed.data);
      };
      source.onerror = () => {
        if (source?.readyState !== EventSource.CLOSED || stopped) return;
        source = null;
        void queryClient.invalidateQueries({ queryKey: keys.session });
        retry = setTimeout(open, STREAM_RETRY_MS);
      };
    };
    const focused = () => {
      if (document.visibilityState === 'visible') {
        for (const listener of reloadListeners) listener();
      }
    };
    open();
    document.addEventListener('visibilitychange', focused);
    return () => {
      stopped = true;
      clearTimeout(retry);
      source?.close();
      document.removeEventListener('visibilitychange', focused);
    };
  }, [enabled]);
}

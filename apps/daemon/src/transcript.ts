import { open } from 'node:fs/promises';
import type { RunLogEvent } from '@orchestrator/protocol';

// The session's transcript, read for the live log only (05, section 4.5). Claude Code documents
// its format as internal and changing between versions, so the reader is tolerant: an unknown or
// malformed line is skipped and counted, never a failure of the run.

export type LogEntry = Omit<RunLogEvent, 'seq'>;

/** Entry types seen in transcripts (ADR 0002): only `user` and `assistant` are shown. */
const KNOWN_TYPES = new Set(['user', 'assistant', 'system', 'attachment', 'cost-state']);

interface ContentPart {
  type?: unknown;
  text?: unknown;
  name?: unknown;
  id?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
  content?: unknown;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part: ContentPart) => (typeof part.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/** A tool call's input as text; the server cuts long entries (02, section 7). */
function inputText(input: unknown): string {
  return typeof input === 'string' ? input : JSON.stringify(input ?? {});
}

export class TranscriptReader {
  /** Tool names by call id, to name results. */
  private readonly tools = new Map<string, string>();
  /**
   * The text of the last assistant entry when Claude Code marked it as an API error
   * (`isApiErrorMessage`), else null: the one fact the usage-limit module reads (05, section 4.10).
   * The daemon clears it when it sends a message.
   */
  lastApiError: string | null = null;
  /** `totalCostUSD` of the last `cost-state` entry: the usage estimate without a status line. */
  costUsd: number | null = null;

  /** `offset`: bytes already read, kept in `state.json` so a restarted daemon goes on from there. */
  constructor(public offset = 0) {}

  /** Reads the complete lines written since the last call. */
  async read(path: string): Promise<{ entries: LogEntry[]; skipped: number }> {
    let text: string;
    const file = await open(path, 'r').catch(() => null);
    if (!file) return { entries: [], skipped: 0 };
    try {
      const { size } = await file.stat();
      if (size <= this.offset) return { entries: [], skipped: 0 };
      const buffer = Buffer.alloc(size - this.offset);
      await file.read(buffer, 0, buffer.length, this.offset);
      const end = buffer.lastIndexOf(0x0a);
      if (end < 0) return { entries: [], skipped: 0 };
      text = buffer.subarray(0, end).toString('utf8');
      this.offset += end + 1;
    } finally {
      await file.close();
    }
    const entries: LogEntry[] = [];
    let skipped = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const read = this.parse(line);
      if (read === null) skipped++;
      else entries.push(...read);
    }
    return { entries, skipped };
  }

  /** The log entries of one line; null when the line is unknown or malformed. */
  private parse(line: string): LogEntry[] | null {
    let entry: {
      type?: unknown;
      timestamp?: unknown;
      isApiErrorMessage?: unknown;
      totalCostUSD?: unknown;
      message?: { content?: unknown };
    };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      return null;
    }
    if (typeof entry !== 'object' || typeof entry.type !== 'string') return null;
    if (!KNOWN_TYPES.has(entry.type)) return null;
    const at =
      typeof entry.timestamp === 'string' && !Number.isNaN(Date.parse(entry.timestamp))
        ? new Date(entry.timestamp).toISOString()
        : new Date().toISOString();
    const content = entry.message?.content;
    const entries: LogEntry[] = [];
    if (entry.type === 'cost-state' && typeof entry.totalCostUSD === 'number') {
      this.costUsd = entry.totalCostUSD;
    }
    if (entry.type === 'assistant') {
      this.lastApiError = entry.isApiErrorMessage === true ? textOf(content) || 'API error' : null;
      if (typeof content === 'string' && content) {
        entries.push({ at, kind: 'agent_text', tool: null, text: content });
      }
      for (const part of Array.isArray(content) ? (content as ContentPart[]) : []) {
        if (part.type === 'text' && typeof part.text === 'string' && part.text) {
          entries.push({ at, kind: 'agent_text', tool: null, text: part.text });
        } else if (part.type === 'tool_use' && typeof part.name === 'string') {
          if (typeof part.id === 'string') this.tools.set(part.id, part.name);
          entries.push({ at, kind: 'tool_call', tool: part.name, text: inputText(part.input) });
        }
      }
    } else if (entry.type === 'user' && Array.isArray(content)) {
      // Messages sent to the agent are logged by the daemon when it sends them.
      for (const part of content as ContentPart[]) {
        if (part.type !== 'tool_result') continue;
        const tool =
          typeof part.tool_use_id === 'string' ? (this.tools.get(part.tool_use_id) ?? null) : null;
        entries.push({ at, kind: 'tool_result', tool, text: textOf(part.content) });
      }
    }
    return entries;
  }
}

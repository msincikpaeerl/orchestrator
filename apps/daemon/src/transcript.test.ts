import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TranscriptReader } from './transcript.js';

let folder: string;
let transcript: string;

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'od-transcript-'));
  transcript = join(folder, 'session.jsonl');
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

const assistant = (text: string) =>
  `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })}\n`;

describe('TranscriptReader', () => {
  it('logs each line once when reads overlap', async () => {
    // The run's timer, the end of a turn and the end of the run each read the transcript; on a
    // slow machine their reads overlap (CI of lot 2 step H: a fourth agent text in the nudge test).
    await appendFile(transcript, assistant('Done.'));
    const reader = new TranscriptReader();
    const results = await Promise.all([reader.read(transcript), reader.read(transcript)]);
    expect(results.flatMap((result) => result.entries.map((entry) => entry.text))).toEqual([
      'Done.',
    ]);

    await appendFile(transcript, assistant('Again.'));
    const later = await Promise.all([
      reader.read(transcript),
      reader.read(transcript),
      reader.read(transcript),
    ]);
    expect(later.flatMap((result) => result.entries.map((entry) => entry.text))).toEqual([
      'Again.',
    ]);
    expect(reader.offset).toBe(Buffer.byteLength(assistant('Done.') + assistant('Again.')));
  });

  it('keeps a partial last line for the next read', async () => {
    const reader = new TranscriptReader();
    const line = assistant('Whole.');
    await appendFile(transcript, line.slice(0, 10));
    expect((await reader.read(transcript)).entries).toEqual([]);
    await appendFile(transcript, line.slice(10));
    expect((await reader.read(transcript)).entries.map((entry) => entry.text)).toEqual(['Whole.']);
  });

  it("skips Claude Code 2.1.287's and 2.1.302's other line types without counting them, and counts unknown ones", async () => {
    // Made-up lines shaped like the real ones of the owner's checks (lot 2 and lot 3, step N),
    // which counted them as unreadable: 17 to 29 per run in lot 2.
    const lines = [
      { type: 'ai-title', aiTitle: 'Add a line', sessionId: 's' },
      { type: 'last-prompt', lastPrompt: 'Implement ticket T-1', leafUuid: 'u', sessionId: 's' },
      { type: 'mode', mode: 'normal', sessionId: 's' },
      { type: 'permission-mode', permissionMode: 'dontAsk', sessionId: 's' },
      { type: 'atis-latch', atis: '', sessionId: 's' },
      { type: 'file-history-snapshot', messageId: 'm', snapshot: {}, isSnapshotUpdate: false },
      { type: 'file-history-delta', messageId: 'm', backup: {}, snapshotMessageId: 'm' },
      { type: 'api-request-shape', sessionId: 's', shapeHash: 'h', shape: { system: [] } },
      {
        type: 'api-request-blob',
        sessionId: 's',
        hash: 'b',
        message: { role: 'user', content: [] },
      },
      { type: 'api-request', sessionId: 's', id: 'r', shapeHash: 'h', tail: ['b'], params: {} },
      { type: 'something-new', sessionId: 's' },
    ];
    await appendFile(transcript, lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
    await appendFile(transcript, assistant('Done.'));
    const result = await new TranscriptReader().read(transcript);
    expect(result.entries.map((entry) => entry.text)).toEqual(['Done.']);
    expect(result.skipped).toBe(1);
  });
});

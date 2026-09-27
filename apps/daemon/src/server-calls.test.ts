import type { McpCall } from '@orchestrator/protocol';
import { describe, expect, it } from 'vitest';
import { DISCONNECTED, ServerCalls } from './server-calls.js';

// The wait for the server's answer to an agent's tool call (06, section 1).

const call: McpCall['payload'] = { tool: 'ticket_get', runToken: 'token', input: {} };

describe('tool calls to the server', () => {
  it('resolves with the result of the same id', async () => {
    const sent: McpCall[] = [];
    const calls = new ServerCalls((message) => sent.push(message) > 0, 1);
    const answer = calls.call(call, 1000);
    expect(sent[0]?.payload).toEqual(call);
    calls.answer({ type: 'mcp.result', id: 'another', payload: { ok: true, output: { x: 2 } } });
    calls.answer({
      type: 'mcp.result',
      id: sent[0]?.id ?? '',
      payload: { ok: true, output: { x: 1 } },
    });
    expect(await answer).toEqual({ ok: true, output: { x: 1 } });
  });

  it('answers UNAVAILABLE after the timeout, naming the setting and its value, and ignores a late result', async () => {
    const sent: McpCall[] = [];
    const calls = new ServerCalls((message) => sent.push(message) > 0, 1);
    const answer = await calls.call(call, 30);
    expect(answer).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
    expect(answer.ok ? '' : answer.error.message).toContain(
      'within 30 seconds (the "MCP call timeout" setting)',
    );
    calls.answer({ type: 'mcp.result', id: sent[0]?.id ?? '', payload: { ok: true, output: {} } });
  });

  it('answers UNAVAILABLE at once while disconnected, and when the connection drops', async () => {
    expect(await new ServerCalls(() => false, 1000).call(call, 30)).toEqual(DISCONNECTED);
    const calls = new ServerCalls(() => true, 1000);
    const waiting = [calls.call(call, 30), calls.call(call, 30)];
    calls.disconnected();
    expect(await Promise.all(waiting)).toEqual([DISCONNECTED, DISCONNECTED]);
  });
});

import { describe, expect, it } from 'vitest';
import { HookInputs, RunSocketRequest, StatusLineInput } from './run-socket.js';

describe('hook inputs', () => {
  it('keeps fields a newer Claude Code adds', () => {
    const parsed = HookInputs.Stop.parse({
      session_id: 's',
      hook_event_name: 'Stop',
      last_assistant_message: 'Done.',
      new_field: 1,
    });
    expect(parsed).toMatchObject({ last_assistant_message: 'Done.', new_field: 1 });
  });

  it('refuses an input without the fields the daemon reads', () => {
    expect(HookInputs.PreToolUse.safeParse({ session_id: 's' }).success).toBe(false);
    expect(HookInputs.SessionStart.safeParse({ source: 'startup' }).success).toBe(false);
  });

  it('reads a status line input with and without rate limits', () => {
    expect(StatusLineInput.parse({ cost: { total_cost_usd: 0.12 } }).cost?.total_cost_usd).toBe(
      0.12,
    );
    expect(
      StatusLineInput.parse({
        rate_limits: { five_hour: { used_percentage: 100, resets_at: 1_790_000_000 } },
      }).rate_limits?.five_hour?.resets_at,
    ).toBe(1_790_000_000);
  });

  it('refuses an unknown request or hook event', () => {
    expect(RunSocketRequest.safeParse({ type: 'hook', event: 'Other', input: {} }).success).toBe(
      false,
    );
    expect(RunSocketRequest.safeParse({ type: 'status' }).success).toBe(false);
  });
});

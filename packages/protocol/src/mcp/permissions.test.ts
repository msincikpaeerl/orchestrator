import { describe, expect, it } from 'vitest';
import { McpPermission, ROLE_MCP_PERMISSIONS, runMcpTools } from './permissions.js';
import { MCP_TOOLS } from './tools.js';

describe('ROLE_MCP_PERMISSIONS', () => {
  it('names every implemented tool as a permission', () => {
    for (const name of Object.keys(MCP_TOOLS)) expect(McpPermission.options).toContain(name);
  });

  it('follows the table of 06, section 5', () => {
    const has = (role: keyof typeof ROLE_MCP_PERMISSIONS, tool: McpPermission) =>
      ROLE_MCP_PERMISSIONS[role].includes(tool);
    for (const role of ['planner', 'builder', 'reviewer', 'writer'] as const) {
      expect(has(role, 'ticket_get') && has(role, 'ticket_ask') && has(role, 'ticket_create')).toBe(
        true,
      );
      expect(new Set(ROLE_MCP_PERMISSIONS[role]).size).toBe(ROLE_MCP_PERMISSIONS[role].length);
    }
    expect(['builder', 'writer'].every((role) => has(role as 'builder', 'ticket_submit'))).toBe(
      true,
    );
    expect(has('planner', 'ticket_submit') || has('reviewer', 'ticket_submit')).toBe(false);
    expect(has('planner', 'plan_propose') && !has('builder', 'plan_propose')).toBe(true);
    expect(has('reviewer', 'review_approve') && !has('builder', 'review_approve')).toBe(true);
    expect(has('planner', 'ticket_update') && !has('builder', 'ticket_update')).toBe(true);
  });
});

describe('runMcpTools', () => {
  const all = McpPermission.options;

  it('lists the review tools only in a review run, and ticket_submit never in one', () => {
    const review = runMcpTools(all, 'review');
    expect(review).toContain('review_approve');
    expect(review).toContain('review_request_changes');
    expect(review).not.toContain('ticket_submit');
    for (const purpose of ['implement', 'fix_review'] as const) {
      const tools = runMcpTools(all, purpose);
      expect(tools).toContain('ticket_submit');
      expect(tools).not.toContain('review_approve');
      expect(tools).not.toContain('review_request_changes');
    }
  });

  it('keeps only implemented tools the profile has, in the order of MCP_TOOLS', () => {
    expect(runMcpTools(ROLE_MCP_PERMISSIONS.builder, 'implement')).toEqual(
      Object.keys(MCP_TOOLS).filter(
        (name) =>
          !name.startsWith('review_') && !name.startsWith('request_') && name !== 'ticket_update',
      ),
    );
    expect(runMcpTools(['ticket_get', 'plan_propose', 'review_approve'], 'review')).toEqual([
      'ticket_get',
      'review_approve',
    ]);
    // A profile that lost a permission does not see that tool.
    expect(runMcpTools(['ticket_get'], 'implement')).toEqual(['ticket_get']);
  });

  it('lists the request tools in a planning run only', () => {
    const plan = runMcpTools(ROLE_MCP_PERMISSIONS.planner, 'plan');
    expect(plan).toEqual(expect.arrayContaining(['request_get', 'request_ask', 'ticket_list']));
    for (const purpose of ['implement', 'review', 'fix_review'] as const) {
      const tools = runMcpTools(all, purpose);
      expect(tools).not.toContain('request_get');
      expect(tools).not.toContain('request_ask');
    }
  });

  it("lists to a planning run the reading tools and its rules' tools only (owner's answer 6, lot 5 step E1)", () => {
    expect(runMcpTools(ROLE_MCP_PERMISSIONS.planner, 'plan')).toEqual([
      'project_get',
      'ticket_get',
      'ticket_list',
      'ticket_comments',
      'request_get',
      'ci_status',
      'agent_list',
      'ticket_progress',
      'request_ask',
      'ticket_give_up',
      'ticket_update',
    ]);
  });

  it('gives a reviewer its tools in a review run and none to decide in an implement run', () => {
    const tools = runMcpTools(ROLE_MCP_PERMISSIONS.reviewer, 'review');
    expect(tools).toEqual(expect.arrayContaining(['ticket_ask', 'ci_status', 'review_approve']));
    const wrong = runMcpTools(ROLE_MCP_PERMISSIONS.reviewer, 'implement');
    expect(wrong.some((name) => name.startsWith('review_') || name === 'ticket_submit')).toBe(
      false,
    );
  });
});

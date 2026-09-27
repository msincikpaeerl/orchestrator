import { describe, expect, it } from 'vitest';
import { McpPermission, ROLE_MCP_PERMISSIONS } from './permissions.js';
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

import { z } from 'zod';
import type { AgentRole } from '../api/agents.js';
import type { RunPurpose } from '../daemon/runs.js';
import { MCP_TOOLS, type McpToolName } from './tools.js';

/**
 * Every MCP tool of 06, section 4, by wire name, including those of later lots: a profile's
 * `mcp_permissions` names them, so the permissions of a role never change when a lot adds its
 * tools (06, section 5). `MCP_TOOLS` defines the tools implemented so far.
 */
export const McpPermission = z.enum([
  'project_get',
  'ticket_get',
  'ticket_list',
  'ticket_comments',
  'request_get',
  'agent_list',
  'ci_status',
  'ticket_progress',
  'ticket_comment',
  'ticket_ask',
  'ticket_submit',
  'ticket_give_up',
  'ticket_create',
  'ticket_update',
  'request_ask',
  'plan_propose',
  'review_approve',
  'review_request_changes',
]);
export type McpPermission = z.infer<typeof McpPermission>;

const READING: readonly McpPermission[] = [
  'project_get',
  'ticket_get',
  'ticket_list',
  'ticket_comments',
  'request_get',
  'agent_list',
  'ci_status',
];
const WORKING: readonly McpPermission[] = [
  'ticket_progress',
  'ticket_comment',
  'ticket_ask',
  'ticket_give_up',
  'ticket_create',
];

/** The MCP permissions of each role: the table of 06, section 5. */
export const ROLE_MCP_PERMISSIONS: Readonly<Record<AgentRole, readonly McpPermission[]>> = {
  planner: [...READING, ...WORKING, 'ticket_update', 'request_ask', 'plan_propose'],
  builder: [...READING, ...WORKING, 'ticket_submit'],
  reviewer: [...READING, ...WORKING, 'review_approve', 'review_request_changes'],
  writer: [...READING, ...WORKING, 'ticket_submit'],
};

/** The tools only a review run decides with (06, section 4.5). */
const REVIEW_TOOLS: readonly McpToolName[] = ['review_approve', 'review_request_changes'];

/**
 * The tools a run may call, carried by `run.start` and the only ones the relay lists (06, section
 * 5; owner's answer 1, lot 3 step H): the implemented tools among the profile's permissions,
 * without those its purpose cannot use: `ticket_submit` in a review run, the review tools in any
 * other. The server still refuses each call by role and purpose.
 */
export function runMcpTools(
  permissions: readonly McpPermission[],
  purpose: RunPurpose,
): McpToolName[] {
  return (Object.keys(MCP_TOOLS) as McpToolName[]).filter((name) => {
    if (!permissions.includes(name)) return false;
    if (purpose === 'review') return name !== 'ticket_submit';
    return !REVIEW_TOOLS.includes(name);
  });
}

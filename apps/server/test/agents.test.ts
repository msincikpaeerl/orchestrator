import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schema } from '@orchestrator/db';
import { AgentListResponse, ApiError, ROLE_MCP_PERMISSIONS } from '@orchestrator/protocol';
import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentsDirectory, loadShippedAgents } from '../src/agents/files.js';
import { seedAgentProfiles } from '../src/agents/seed.js';
import { createOwner, startTestApp, type TestApp } from './helpers.js';

let t: TestApp;
/** A copy of `agents/`, changed by the tests as a new version of the application would. */
let shippedCopy: string;

beforeEach(async () => {
  t = await startTestApp();
  shippedCopy = await mkdtemp(join(tmpdir(), 'od-agents-'));
  await cp(agentsDirectory(), shippedCopy, { recursive: true });
});

afterEach(async () => {
  await t.close();
  await rm(shippedCopy, { recursive: true, force: true });
});

async function profiles() {
  return t.db.select().from(schema.agentProfiles).orderBy(asc(schema.agentProfiles.key));
}

async function profileEvents() {
  const rows = await t.db.select().from(schema.events).orderBy(asc(schema.events.id));
  return rows.filter((row) => row.entityType === 'agent_profile');
}

async function changeFile(file: string, change: (text: string) => string) {
  const path = join(shippedCopy, file);
  await writeFile(path, change(await readFile(path, 'utf8')));
}

describe('seeding the default profiles (03, section 3)', () => {
  it('seeds the Architect, Quality and the Web Developer at start, with their events', async () => {
    const rows = await profiles();
    expect(rows.map((row) => row.key)).toEqual(['architect', 'quality', 'web_dev']);
    // Quality is the reviewer (03, section 2.5; lot 3 step H1).
    expect(rows[1]).toMatchObject({
      role: 'reviewer',
      model: 'sonnet',
      isDefault: true,
      version: 1,
      mcpPermissions: ROLE_MCP_PERMISSIONS.reviewer,
    });
    for (const row of rows.filter((each) => each.key !== 'quality')) {
      expect(row).toMatchObject({
        role: 'builder',
        model: 'sonnet',
        isDefault: true,
        version: 1,
        requiredCapabilities: [],
        mcpPermissions: ROLE_MCP_PERMISSIONS.builder,
      });
      expect(row.allowedTools).toContain('ToolSearch');
      expect(row.instructions).toMatch(/^# Your role: /);
    }
    expect(
      (await profileEvents()).map((event) => [event.type, event.actor, event.payload]),
    ).toEqual([
      ['agent_profile.created', 'system', { key: 'architect', name: 'Architect', version: 1 }],
      ['agent_profile.created', 'system', { key: 'quality', name: 'Quality', version: 1 }],
      ['agent_profile.created', 'system', { key: 'web_dev', name: 'Web Developer', version: 1 }],
    ]);
  });

  it('changes nothing when the shipped files are unchanged', async () => {
    const before = await profiles();
    expect(await seedAgentProfiles(t.db, await loadShippedAgents())).toEqual({
      created: [],
      updated: [],
    });
    expect(await profiles()).toEqual(before);
    expect(await profileEvents()).toHaveLength(3);
  });

  it("raises a profile's version when its file changed, with its event", async () => {
    await changeFile('web_dev.md', (text) =>
      text.replace('- Bash(sort *)', '- Bash(sort *)\n  - Bash(uniq *)'),
    );
    const result = await seedAgentProfiles(t.db, await loadShippedAgents(shippedCopy));
    expect(result).toEqual({ created: [], updated: ['web_dev'] });
    const [architect, quality, webDev] = await profiles();
    expect(architect?.version).toBe(1);
    expect(quality?.version).toBe(1);
    expect(webDev?.version).toBe(2);
    expect(webDev?.allowedTools).toContain('Bash(uniq *)');
    expect((await profileEvents()).at(-1)).toMatchObject({
      type: 'agent_profile.updated',
      actor: 'system',
      entityId: webDev?.id,
      payload: { key: 'web_dev', name: 'Web Developer', previousVersion: 1, version: 2 },
    });

    // The next start with the same files changes nothing more.
    await seedAgentProfiles(t.db, await loadShippedAgents(shippedCopy));
    expect((await profiles()).map((row) => row.version)).toEqual([1, 1, 2]);
  });

  it('raises every default profile when the shared rules changed', async () => {
    await changeFile('rules/shared.md', (text) => `${text}\nOne more rule.\n`);
    const result = await seedAgentProfiles(t.db, await loadShippedAgents(shippedCopy));
    expect(result.updated).toEqual(['architect', 'quality', 'web_dev']);
    expect((await profiles()).map((row) => row.version)).toEqual([2, 2, 2]);
  });

  it('raises only the profiles whose runs receive the builder or the reviewer rules when they changed (lot 3 step H5)', async () => {
    await changeFile('rules/builder.md', (text) =>
      text.replace('Never rebase', 'Never, ever rebase'),
    );
    expect((await seedAgentProfiles(t.db, await loadShippedAgents(shippedCopy))).updated).toEqual([
      'architect',
      'web_dev',
    ]);
    await changeFile('rules/reviewer.md', (text) => text.replace('Never push', 'Never, ever push'));
    expect((await seedAgentProfiles(t.db, await loadShippedAgents(shippedCopy))).updated).toEqual([
      'quality',
    ]);
    expect((await profiles()).map((row) => row.version)).toEqual([2, 2, 2]);
  });

  it('raises every default profile when the allowlist template changed', async () => {
    await changeFile('templates/allowlist.md', (text) => text.replace('Any other', 'Every other'));
    const result = await seedAgentProfiles(t.db, await loadShippedAgents(shippedCopy));
    expect(result.updated).toEqual(['architect', 'quality', 'web_dev']);
  });

  it('keeps the profile row, so tickets assigned to it stay assigned', async () => {
    const [before] = await t.db
      .select()
      .from(schema.agentProfiles)
      .where(eq(schema.agentProfiles.key, 'web_dev'));
    await changeFile('web_dev.md', (text) => text.replace('name: Web Developer', 'name: Web Dev'));
    await seedAgentProfiles(t.db, await loadShippedAgents(shippedCopy));
    const [after] = await t.db
      .select()
      .from(schema.agentProfiles)
      .where(eq(schema.agentProfiles.key, 'web_dev'));
    expect(after).toMatchObject({ id: before?.id, name: 'Web Dev', version: 2 });
  });

  it('seeds once when two starts race', async () => {
    const shipped = await loadShippedAgents(shippedCopy);
    await changeFile('architect.md', (text) => `${text}\nOne more line.\n`);
    const changed = await loadShippedAgents(shippedCopy);
    await Promise.all([seedAgentProfiles(t.db, changed), seedAgentProfiles(t.db, changed)]);
    expect((await profiles()).map((row) => row.version)).toEqual([2, 1, 1]);
    expect(shipped.profiles[0]?.shippedHash).not.toBe(changed.profiles[0]?.shippedHash);
    expect(await profileEvents()).toHaveLength(4);
  });
});

describe('GET /api/agents', () => {
  it('lists the profiles by name for the owner', async () => {
    const cookie = await createOwner(t.app);
    const response = await t.app.inject({ method: 'GET', url: '/api/agents', headers: { cookie } });
    expect(response.statusCode, response.body).toBe(200);
    expect(AgentListResponse.parse(response.json()).agents).toEqual([
      expect.objectContaining({ key: 'architect', name: 'Architect', role: 'builder', version: 1 }),
      expect.objectContaining({ key: 'quality', name: 'Quality', role: 'reviewer' }),
      expect.objectContaining({ key: 'web_dev', name: 'Web Developer', model: 'sonnet' }),
    ]);
  });

  it('requires a session', async () => {
    const response = await t.app.inject({ method: 'GET', url: '/api/agents' });
    expect(response.statusCode).toBe(401);
    expect(ApiError.parse(response.json()).error.code).toBe('not_authenticated');
  });
});

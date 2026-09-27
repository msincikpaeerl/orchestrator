import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/migrate.js';
import { endPool } from '../src/pool.js';
import { createTestDatabase, type TestDatabase } from '../src/testing.js';

describe('ticket dependencies', () => {
  let database: TestDatabase;
  let pool: pg.Pool;

  beforeEach(async () => {
    database = await createTestDatabase();
    pool = new pg.Pool({ connectionString: database.url });
    await runMigrations(pool);
  });

  afterEach(async () => {
    await endPool(pool);
    await database.drop();
  });

  async function project(key: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO projects (key, name, slug, description, kind, repo_owner, repo_name, repo_origin,
         repo_private, setup_status)
       VALUES ($1, $1, $1, '', 'web_app', 'owner', $1, 'created', true, 'ready') RETURNING id`,
      [key],
    );
    return rows[0]?.id ?? '';
  }

  async function ticket(projectId: string, number: number): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tickets (project_id, number, type, title, description, priority, status, created_by)
       VALUES ($1, $2, 'feature', 'T', '', 'normal', 'todo', 'owner') RETURNING id`,
      [projectId, number],
    );
    return rows[0]?.id ?? '';
  }

  function depend(projectId: string, ticketId: string, blockedById: string) {
    return pool.query(
      'INSERT INTO ticket_dependencies (project_id, ticket_id, blocked_by_id) VALUES ($1, $2, $3)',
      [projectId, ticketId, blockedById],
    );
  }

  it('keeps both tickets in one project and never lets a ticket depend on itself', async () => {
    const web = await project('WEB');
    const app = await project('APP');
    const first = await ticket(web, 1);
    const second = await ticket(web, 2);
    const other = await ticket(app, 1);

    await depend(web, first, second);
    await expect(depend(web, first, other)).rejects.toThrow(/ticket_dependencies_blocked_by/);
    await expect(depend(app, first, other)).rejects.toThrow(/ticket_dependencies_ticket/);
    await expect(depend(web, first, first)).rejects.toThrow(/ticket_dependencies_not_itself/);
  });

  it('never gives two tickets of a project the same number', async () => {
    const web = await project('WEB');
    await ticket(web, 1);
    await expect(ticket(web, 1)).rejects.toThrow(/tickets_project_number/);
  });
});

import { schema } from '@orchestrator/db';
import {
  PROJECT_SETTINGS,
  ProjectKey,
  SETTINGS,
  SetSettingRequest,
  SettingName,
  settingValue,
  type GlobalSettingsResponse,
  type ProjectSettingsResponse,
} from '@orchestrator/protocol';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requireSession } from '../auth/routes.js';
import type { Database, Executor } from '../database.js';
import { HttpError, parseInput } from '../http.js';
import { changeSetting, storedValues } from './store.js';

type SettingParams = { Params: { name: string } };
type ProjectSettingParams = { Params: { key: string; name: string } };

function findName(name: string): SettingName {
  const parsed = SettingName.safeParse(name);
  if (!parsed.success) throw new HttpError(404, 'setting_not_found', 'No setting with this name');
  return parsed.data;
}

function findProjectName(name: string): SettingName {
  const found = findName(name);
  if (!SETTINGS[found].perProject) {
    throw new HttpError(
      409,
      'setting_not_per_project',
      'This setting has only a global value: change it in Settings > Limits',
    );
  }
  return found;
}

/** The value of the request body, checked against the setting's allowed range. */
function parseValue(name: SettingName, body: unknown): number {
  return parseInput(SetSettingRequest.extend({ value: settingValue(name) }), body).value;
}

async function globalSettings(db: Executor): Promise<GlobalSettingsResponse> {
  const stored = await storedValues(db, null);
  return {
    settings: SettingName.options.map((name) => ({
      name,
      value: stored.get(name) ?? SETTINGS[name].default,
      isDefault: !stored.has(name),
    })),
  };
}

async function projectSettings(db: Executor, projectId: string): Promise<ProjectSettingsResponse> {
  const [global, overrides] = await Promise.all([
    storedValues(db, null),
    storedValues(db, projectId),
  ]);
  return {
    settings: PROJECT_SETTINGS.map((name) => ({
      name,
      override: overrides.get(name) ?? null,
      globalValue: global.get(name) ?? SETTINGS[name].default,
    })),
  };
}

/**
 * Settings > Limits and the overrides of project settings (02, sections 6.5 and 10; 04,
 * section 8). A change applies to the next action that reads the setting, and writes an event.
 */
export function registerSettingRoutes(app: FastifyInstance, { db }: { db: Database }) {
  app.get('/api/settings', async (request) => {
    await requireSession(db, request);
    return globalSettings(db);
  });

  app.put<SettingParams>('/api/settings/:name', async (request) => {
    await requireSession(db, request);
    const name = findName(request.params.name);
    const value = parseValue(name, request.body);
    await db.transaction((tx) => changeSetting(tx, name, { projectId: null }, value));
    request.log.info({ setting: name, value }, 'setting changed');
    return globalSettings(db);
  });

  app.delete<SettingParams>('/api/settings/:name', async (request) => {
    await requireSession(db, request);
    const name = findName(request.params.name);
    await db.transaction((tx) => changeSetting(tx, name, { projectId: null }, null));
    request.log.info({ setting: name }, 'setting reset to default');
    return globalSettings(db);
  });

  /** Changes a project's override under the project's row lock, so archiving waits for it. */
  async function changeProject(
    key: string,
    name: SettingName,
    value: number | null,
  ): Promise<ProjectSettingsResponse> {
    const parsed = ProjectKey.safeParse(key);
    return db.transaction(async (tx) => {
      const [project] = parsed.success
        ? await tx
            .select()
            .from(schema.projects)
            .where(eq(schema.projects.key, parsed.data))
            .for('no key update')
        : [];
      if (!project) throw new HttpError(404, 'project_not_found', 'No project with this key');
      if (project.status === 'archived') {
        throw new HttpError(
          409,
          'project_archived',
          'This project is archived and read-only: unarchive it first',
        );
      }
      await changeSetting(tx, name, { projectId: project.id, projectKey: project.key }, value);
      return projectSettings(tx, project.id);
    });
  }

  app.get<{ Params: { key: string } }>('/api/projects/:key/settings', async (request) => {
    await requireSession(db, request);
    const parsed = ProjectKey.safeParse(request.params.key);
    const [project] = parsed.success
      ? await db.select().from(schema.projects).where(eq(schema.projects.key, parsed.data))
      : [];
    if (!project) throw new HttpError(404, 'project_not_found', 'No project with this key');
    return projectSettings(db, project.id);
  });

  app.put<ProjectSettingParams>('/api/projects/:key/settings/:name', async (request) => {
    await requireSession(db, request);
    const name = findProjectName(request.params.name);
    const value = parseValue(name, request.body);
    const result = await changeProject(request.params.key, name, value);
    request.log.info({ setting: name, project: request.params.key, value }, 'setting overridden');
    return result;
  });

  app.delete<ProjectSettingParams>('/api/projects/:key/settings/:name', async (request) => {
    await requireSession(db, request);
    const name = findProjectName(request.params.name);
    const result = await changeProject(request.params.key, name, null);
    request.log.info({ setting: name, project: request.params.key }, 'setting override removed');
    return result;
  });
}

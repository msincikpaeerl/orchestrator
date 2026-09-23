import { schema } from '@orchestrator/db';
import {
  ApiError,
  GlobalSettingsResponse,
  PROJECT_SETTINGS,
  ProjectSettingsResponse,
  SETTINGS,
  SettingName,
} from '@orchestrator/protocol';
import { asc, like } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { changeSetting, resolveSettings } from '../src/settings/store.js';
import { createOwner, startTestApp, type TestApp } from './helpers.js';

let t: TestApp;
let cookie: string;

beforeEach(async () => {
  t = await startTestApp();
  cookie = await createOwner(t.app);
});

afterEach(async () => {
  await t.close();
});

async function seedProject(key: string, status: 'active' | 'archived' = 'active') {
  const [row] = await t.db
    .insert(schema.projects)
    .values({
      key,
      name: key,
      slug: key.toLowerCase(),
      description: '',
      kind: 'web_app',
      repoOwner: 'owner',
      repoName: key.toLowerCase(),
      repoOrigin: 'created',
      repoPrivate: true,
      defaultBranch: 'main',
      setupStatus: 'ready',
      branchProtection: 'applied',
      status,
    })
    .returning();
  if (!row) throw new Error('project not inserted');
  return row;
}

function call(method: 'GET' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  return t.app.inject({
    method,
    url: `/api/${url}`,
    headers: { cookie },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

async function globalValues() {
  const response = await call('GET', 'settings');
  expect(response.statusCode).toBe(200);
  return GlobalSettingsResponse.parse(response.json()).settings;
}

function error(response: { json: () => unknown }) {
  return ApiError.parse(response.json()).error;
}

async function settingEvents() {
  const rows = await t.db
    .select()
    .from(schema.events)
    .where(like(schema.events.type, 'setting.%'))
    .orderBy(asc(schema.events.id));
  return rows.map(({ type, entityType, entityId, actor, payload }) => ({
    type,
    entityType,
    entityId,
    actor,
    payload,
  }));
}

describe('Settings > Limits', () => {
  it('keeps the values used before settings could be changed, for an owner who changed nothing', async () => {
    const values = Object.fromEntries((await globalValues()).map((s) => [s.name, s.value]));
    // The values of lots 0 and 1, written out: a changed default fails here on purpose.
    expect(values).toMatchObject({
      sessionLifetimeDays: 30,
      loginFailuresBeforeDelay: 5,
      loginFirstDelaySeconds: 10,
      loginMaxDelaySeconds: 900,
      loginFailureMemoryMinutes: 60,
      githubTokenExpiryWarningDays: 14,
      githubRequestTimeoutSeconds: 15,
      githubClockToleranceSeconds: 120,
      projectSetupPollSeconds: 2,
      ticketTitleMaxLength: 200,
      ticketDescriptionMaxLength: 20_000,
      ticketMaxAcceptanceCriteria: 20,
      acceptanceCriterionMaxLength: 500,
      commentMaxLength: 20_000,
    });
    expect((await globalValues()).every((s) => s.isDefault)).toBe(true);
    expect((await globalValues()).map((s) => s.name)).toEqual(SettingName.options);
  });

  it('changes a value, writes an event, and writes nothing when the value is the same', async () => {
    const response = await call('PUT', 'settings/commentMaxLength', { value: 5000 });
    expect(response.statusCode, response.body).toBe(200);
    const changed = GlobalSettingsResponse.parse(response.json()).settings.find(
      (s) => s.name === 'commentMaxLength',
    );
    expect(changed).toEqual({ name: 'commentMaxLength', value: 5000, isDefault: false });
    await call('PUT', 'settings/commentMaxLength', { value: 6000 });
    await call('PUT', 'settings/commentMaxLength', { value: 6000 });
    expect(await settingEvents()).toEqual([
      {
        type: 'setting.changed',
        entityType: 'setting',
        entityId: 'commentMaxLength',
        actor: 'owner',
        payload: { name: 'commentMaxLength', scope: 'global', previous: null, value: 5000 },
      },
      {
        type: 'setting.changed',
        entityType: 'setting',
        entityId: 'commentMaxLength',
        actor: 'owner',
        payload: { name: 'commentMaxLength', scope: 'global', previous: 5000, value: 6000 },
      },
    ]);
  });

  it('keeps a value equal to the default as a value until Reset to default', async () => {
    await call('PUT', 'settings/sessionLifetimeDays', { value: 30 });
    const kept = (await globalValues()).find((s) => s.name === 'sessionLifetimeDays');
    expect(kept).toEqual({ name: 'sessionLifetimeDays', value: 30, isDefault: false });
  });

  it('refuses values outside the allowed range, and names the range', async () => {
    for (const [name, body, message] of [
      ['sessionLifetimeDays', { value: 0 }, 'value: must be between 1 and 365 days'],
      ['sessionLifetimeDays', { value: 366 }, 'value: must be between 1 and 365 days'],
      ['loginFirstDelaySeconds', { value: 1.5 }, 'value: must be a whole number of seconds'],
      ['commentMaxLength', { value: '100' }, null],
      ['commentMaxLength', {}, null],
    ] as const) {
      const response = await call('PUT', `settings/${name}`, body);
      expect(response.statusCode).toBe(400);
      expect(error(response).code).toBe('invalid_request');
      if (message) expect(error(response).message).toBe(message);
    }
    // The limits of the allowed range are accepted.
    expect(
      (await call('PUT', 'settings/githubClockToleranceSeconds', { value: 0 })).statusCode,
    ).toBe(200);
    expect((await call('PUT', 'settings/sessionLifetimeDays', { value: 365 })).statusCode).toBe(
      200,
    );
    expect((await globalValues()).filter((s) => !s.isDefault).map((s) => s.name)).toEqual([
      'sessionLifetimeDays',
      'githubClockToleranceSeconds',
    ]);
  });

  it('refuses an unknown setting', async () => {
    for (const response of [
      await call('PUT', 'settings/noSuchSetting', { value: 1 }),
      await call('DELETE', 'settings/noSuchSetting'),
      await call('PUT', 'settings/constructor', { value: 1 }),
    ]) {
      expect(response.statusCode).toBe(404);
      expect(error(response).code).toBe('setting_not_found');
    }
  });

  it('resets to the default, with an event, and does nothing for a setting already at its default', async () => {
    await call('PUT', 'settings/idleTimeoutMinutes', { value: 15 });
    const reset = await call('DELETE', 'settings/idleTimeoutMinutes');
    expect(reset.statusCode).toBe(200);
    expect(
      GlobalSettingsResponse.parse(reset.json()).settings.find(
        (s) => s.name === 'idleTimeoutMinutes',
      ),
    ).toEqual({ name: 'idleTimeoutMinutes', value: 10, isDefault: true });
    expect((await call('DELETE', 'settings/idleTimeoutMinutes')).statusCode).toBe(200);
    expect((await settingEvents()).map((event) => [event.type, event.payload])).toEqual([
      [
        'setting.changed',
        { name: 'idleTimeoutMinutes', scope: 'global', previous: null, value: 15 },
      ],
      ['setting.reset', { name: 'idleTimeoutMinutes', scope: 'global', previous: 15 }],
    ]);
  });

  it('needs a session', async () => {
    for (const [method, url] of [
      ['GET', '/api/settings'],
      ['PUT', '/api/settings/commentMaxLength'],
      ['DELETE', '/api/settings/commentMaxLength'],
      ['GET', '/api/projects/WEB/settings'],
      ['PUT', '/api/projects/WEB/settings/maxTicketsPerPlan'],
      ['DELETE', '/api/projects/WEB/settings/maxTicketsPerPlan'],
    ] as const) {
      const response = await t.app.inject({ method, url, payload: { value: 1 } });
      expect(response.statusCode).toBe(401);
    }
  });

  it('applies a changed ticket limit to the next ticket, without a restart', async () => {
    await seedProject('WEB');
    const ticket = { type: 'feature', title: 'A title of 25 characters' };
    await call('PUT', 'settings/ticketTitleMaxLength', { value: 10 });
    const refused = await t.app.inject({
      method: 'POST',
      url: '/api/projects/WEB/tickets',
      headers: { cookie },
      payload: ticket,
    });
    expect(refused.statusCode).toBe(400);
    expect(error(refused).limits).toEqual([{ field: 'title', max: 10, unit: 'characters' }]);
    await call('DELETE', 'settings/ticketTitleMaxLength');
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/projects/WEB/tickets',
      headers: { cookie },
      payload: ticket,
    });
    expect(created.statusCode, created.body).toBe(201);
  });
});

describe('settings that must stay in order', () => {
  const first = 'settings/quotaFallbackDelayMinutes';
  const longest = 'settings/quotaFallbackMaxDelayMinutes';

  it('refuses a first quota wait above the longest, and a longest below the first', async () => {
    const above = await call('PUT', first, { value: 241 });
    expect(above.statusCode).toBe(409);
    expect(error(above)).toMatchObject({
      code: 'setting_order_invalid',
      settingOrder: {
        smaller: 'quotaFallbackDelayMinutes',
        larger: 'quotaFallbackMaxDelayMinutes',
        smallerValue: 241,
        largerValue: 240,
      },
    });
    const below = await call('PUT', longest, { value: 59 });
    expect(below.statusCode).toBe(409);
    expect(error(below).settingOrder).toMatchObject({ smallerValue: 60, largerValue: 59 });
    // Equal values are in order.
    expect((await call('PUT', longest, { value: 60 })).statusCode).toBe(200);
    // Nothing was stored or recorded for the refused changes.
    expect((await settingEvents()).map((event) => event.payload)).toEqual([
      { name: 'quotaFallbackMaxDelayMinutes', scope: 'global', previous: null, value: 60 },
    ]);
  });

  it('refuses a Reset to default that would break the order', async () => {
    await call('PUT', first, { value: 10 });
    await call('PUT', longest, { value: 30 });
    // The first wait's default (60) would be above the longest (30).
    const reset = await call('DELETE', first);
    expect(reset.statusCode).toBe(409);
    expect(error(reset).settingOrder).toMatchObject({ smallerValue: 60, largerValue: 30 });
    const values = await globalValues();
    expect(values.find((s) => s.name === 'quotaFallbackDelayMinutes')?.value).toBe(10);
    // Reset the longest wait first (240), then the first wait: both allowed.
    expect((await call('DELETE', longest)).statusCode).toBe(200);
    expect((await call('DELETE', first)).statusCode).toBe(200);
  });

  it('never lets two changes that are each in order break the order together', async () => {
    await call('PUT', first, { value: 100 });
    await call('PUT', longest, { value: 200 });
    // The first change stays uncommitted while the second one runs: the second must wait for it,
    // then see it. Without waiting, both would be committed (150 above 120).
    let firstChanged!: () => void;
    const changed = new Promise<void>((resolve) => (firstChanged = resolve));
    let commitFirst!: () => void;
    const commit = new Promise<void>((resolve) => (commitFirst = resolve));
    const one = t.db.transaction(async (tx) => {
      await changeSetting(tx, 'quotaFallbackDelayMinutes', { projectId: null }, 150);
      firstChanged();
      await commit;
    });
    await changed;
    const two = t.db
      .transaction((tx) =>
        changeSetting(tx, 'quotaFallbackMaxDelayMinutes', { projectId: null }, 120),
      )
      .then(
        () => 'committed',
        (refusal: unknown) => refusal,
      );
    const early = await Promise.race([
      two,
      new Promise((resolve) => {
        setTimeout(() => {
          resolve('waiting');
        }, 300);
      }),
    ]);
    expect(early).toBe('waiting');
    commitFirst();
    await one;
    expect(await two).toMatchObject({ code: 'setting_order_invalid' });
    const values = Object.fromEntries((await globalValues()).map((s) => [s.name, s.value]));
    expect([values.quotaFallbackDelayMinutes, values.quotaFallbackMaxDelayMinutes]).toEqual([
      150, 200,
    ]);
  });

  it('cannot be broken by a project, since both are global only', async () => {
    await seedProject('WEB');
    for (const response of [
      await call('PUT', 'projects/WEB/settings/quotaFallbackDelayMinutes', { value: 300 }),
      await call('PUT', 'projects/WEB/settings/quotaFallbackMaxDelayMinutes', { value: 1 }),
    ]) {
      expect(error(response).code).toBe('setting_not_per_project');
    }
  });
});

describe('project overrides', () => {
  async function projectValues(key: string) {
    const response = await call('GET', `projects/${key}/settings`);
    expect(response.statusCode, response.body).toBe(200);
    return ProjectSettingsResponse.parse(response.json()).settings;
  }

  it('lists only the settings a project can override, with the global value', async () => {
    await seedProject('WEB');
    await call('PUT', 'settings/maxTicketsPerPlan', { value: 12 });
    const values = await projectValues('WEB');
    expect(values.map((s) => s.name)).toEqual(PROJECT_SETTINGS);
    expect(values.find((s) => s.name === 'maxTicketsPerPlan')).toEqual({
      name: 'maxTicketsPerPlan',
      override: null,
      globalValue: 12,
    });
    // Settings added in lots 0 and 1 are global only (04, section 8).
    for (const name of SettingName.options) {
      if (!SETTINGS[name].usedFrom) expect(SETTINGS[name].perProject).toBe(false);
    }
  });

  it('overrides, validates and resets, with events naming the project', async () => {
    const project = await seedProject('WEB');
    const saved = await call('PUT', 'projects/WEB/settings/ciWaitTimeoutMinutes', { value: 45 });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(
      ProjectSettingsResponse.parse(saved.json()).settings.find(
        (s) => s.name === 'ciWaitTimeoutMinutes',
      ),
    ).toEqual({ name: 'ciWaitTimeoutMinutes', override: 45, globalValue: 20 });

    const outside = await call('PUT', 'projects/WEB/settings/ciWaitTimeoutMinutes', { value: 0 });
    expect(outside.statusCode).toBe(400);
    expect(error(outside).message).toBe('value: must be between 1 and 240 minutes');

    const reset = await call('DELETE', 'projects/WEB/settings/ciWaitTimeoutMinutes');
    expect(reset.statusCode).toBe(200);
    expect((await projectValues('WEB')).every((s) => s.override === null)).toBe(true);

    expect((await settingEvents()).map((event) => [event.type, event.payload])).toEqual([
      [
        'setting.changed',
        {
          name: 'ciWaitTimeoutMinutes',
          scope: 'project',
          projectId: project.id,
          projectKey: 'WEB',
          previous: null,
          value: 45,
        },
      ],
      [
        'setting.reset',
        {
          name: 'ciWaitTimeoutMinutes',
          scope: 'project',
          projectId: project.id,
          projectKey: 'WEB',
          previous: 45,
        },
      ],
    ]);
  });

  it('refuses a global-only setting, an unknown project and an archived project', async () => {
    await seedProject('WEB');
    await seedProject('OLD', 'archived');
    const globalOnly = await call('PUT', 'projects/WEB/settings/commentMaxLength', { value: 10 });
    expect(globalOnly.statusCode).toBe(409);
    expect(error(globalOnly).code).toBe('setting_not_per_project');
    expect((await call('DELETE', 'projects/WEB/settings/commentMaxLength')).statusCode).toBe(409);

    for (const response of [
      await call('GET', 'projects/NOPE/settings'),
      await call('PUT', 'projects/NOPE/settings/maxTicketsPerPlan', { value: 3 }),
      await call('PUT', 'projects/bad-key/settings/maxTicketsPerPlan', { value: 3 }),
    ]) {
      expect(error(response).code).toBe('project_not_found');
    }

    const archived = await call('PUT', 'projects/OLD/settings/maxTicketsPerPlan', { value: 3 });
    expect(archived.statusCode).toBe(409);
    expect(error(archived).code).toBe('project_archived');
    // An archived project's settings can still be read.
    expect((await projectValues('OLD')).length).toBe(PROJECT_SETTINGS.length);
    expect(await settingEvents()).toEqual([]);
  });

  it('resolves the project override, then the global value, then the default', async () => {
    const web = await seedProject('WEB');
    const app = await seedProject('APP');
    const resolve = async (projectId?: string) =>
      (await resolveSettings(t.db, ['maxTicketsPerPlan', 'maxFailedAttempts'], projectId))
        .maxTicketsPerPlan;

    expect(await resolve(web.id)).toBe(15);
    await call('PUT', 'settings/maxTicketsPerPlan', { value: 20 });
    expect(await resolve(web.id)).toBe(20);
    await call('PUT', 'projects/WEB/settings/maxTicketsPerPlan', { value: 7 });
    expect(await resolve(web.id)).toBe(7);
    // Another project and the global value are not affected by WEB's override.
    expect(await resolve(app.id)).toBe(20);
    expect(await resolve()).toBe(20);
    // The global value changes under the override without replacing it.
    await call('PUT', 'settings/maxTicketsPerPlan', { value: 25 });
    expect(await resolve(web.id)).toBe(7);
    await call('DELETE', 'projects/WEB/settings/maxTicketsPerPlan');
    expect(await resolve(web.id)).toBe(25);
    await call('DELETE', 'settings/maxTicketsPerPlan');
    expect(await resolve(web.id)).toBe(15);
    // A setting nobody changed resolves to its default in every scope.
    expect((await resolveSettings(t.db, ['maxFailedAttempts'], web.id)).maxFailedAttempts).toBe(2);
  });
});

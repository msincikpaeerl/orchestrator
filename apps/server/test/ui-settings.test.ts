import { UiSettingsResponse } from '@orchestrator/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createOwner, startTestApp, type TestApp } from './helpers.js';

let t: TestApp | undefined;

afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe('GET /api/ui-settings', () => {
  it('gives the setup polling interval from the settings', async () => {
    t = await startTestApp({ settings: { projectSetupPollSeconds: 7 } });
    const cookie = await createOwner(t.app);
    const response = await t.app.inject({
      method: 'GET',
      url: '/api/ui-settings',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(UiSettingsResponse.parse(response.json())).toEqual({ projectSetupPollSeconds: 7 });
  });

  it('defaults to 2 seconds', async () => {
    t = await startTestApp();
    const cookie = await createOwner(t.app);
    const response = await t.app.inject({
      method: 'GET',
      url: '/api/ui-settings',
      headers: { cookie },
    });
    expect(response.json()).toEqual({ projectSetupPollSeconds: 2 });
  });

  it('follows a change made in Settings > Limits', async () => {
    t = await startTestApp();
    const cookie = await createOwner(t.app);
    const changed = await t.app.inject({
      method: 'PUT',
      url: '/api/settings/projectSetupPollSeconds',
      headers: { cookie },
      payload: { value: 5 },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    const response = await t.app.inject({
      method: 'GET',
      url: '/api/ui-settings',
      headers: { cookie },
    });
    expect(response.json()).toEqual({ projectSetupPollSeconds: 5 });
  });

  it('needs a session', async () => {
    t = await startTestApp();
    const response = await t.app.inject({ method: 'GET', url: '/api/ui-settings' });
    expect(response.statusCode).toBe(401);
  });
});

import {
  comeBack,
  completeSetup,
  connectDaemon,
  createMachine,
  expect,
  expectFitsScreen,
  openSection,
  readyForRuns,
  runNow,
  startRun,
  test,
} from './fixtures';

test('adding a Claude account, then editing it', async ({ page }) => {
  await completeSetup(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'No Claude account yet' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No machine enrolled yet' })).toBeVisible();
  await expectFitsScreen(page);

  await page.getByRole('link', { name: 'Open Machines' }).click();
  await expect(page.getByRole('heading', { name: 'Machines', level: 1 })).toBeVisible();
  await expect(page.getByText('No Claude account yet. Add the account')).toBeVisible();
  // A machine needs an account first.
  await expect(page.getByRole('link', { name: 'Add machine' })).toBeHidden();

  await page.getByRole('button', { name: 'Add a Claude account' }).click();
  await page.getByRole('button', { name: 'Add the account' }).click();
  await expect(page.getByText('Enter a label.')).toBeVisible();
  await page.getByLabel('Label').fill('Personal');
  await page.getByLabel('Plan').selectOption({ label: 'Max 5x' });
  await page.getByLabel('Runs at the same time').selectOption('2');
  await expectFitsScreen(page);
  await page.getByRole('button', { name: 'Add the account' }).click();

  const accounts = page.getByRole('list', { name: 'Claude accounts' });
  await expect(accounts.getByRole('listitem')).toHaveCount(1);
  await expect(accounts).toContainText('Personal');
  await expect(accounts).toContainText('Max 5x · 2 runs at a time');

  // A second account cannot reuse the label, whatever its case.
  await page.getByRole('button', { name: 'Add a Claude account' }).click();
  await page.getByLabel('Label').fill('personal');
  await page.getByRole('button', { name: 'Add the account' }).click();
  await expect(page.getByText('Another Claude account already has this label.')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();

  await page.getByRole('button', { name: 'Edit Personal' }).click();
  await page.getByLabel('Label').fill('Home');
  await page.getByLabel('Plan').selectOption({ label: 'Max 20x' });
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(accounts).toContainText('Home');
  await expect(accounts).toContainText('Max 20x · 2 runs at a time');

  await openSection(page, 'Needs you');
  await expect(page.getByRole('heading', { level: 2 })).toHaveText(['No machine enrolled yet']);
});

test('adding a machine until its daemon connects, editing capabilities, revoking it', async ({
  page,
}) => {
  await completeSetup(page);
  expect(
    (
      await page.request.post('/api/accounts', { data: { label: 'Personal', plan: 'pro' } })
    ).status(),
  ).toBe(201);
  await page.goto('/');
  await page.getByRole('link', { name: 'Add machine' }).click();

  await expect(page.getByRole('heading', { name: 'Add machine', level: 1 })).toBeVisible();
  await page.getByLabel('Name').fill('Desktop');
  await expect(page.getByLabel('Claude account')).toHaveValue(/.+/);
  await page.getByRole('button', { name: 'Show the commands' }).click();

  await expect(page.getByLabel('Install command')).toContainText(
    /^npm install -g http:\/\/localhost:\d+\/downloads\/orchestrator-daemon-[\d.]+\.tgz$/,
  );
  const enroll = page.getByLabel('Enroll command');
  await expect(enroll).toContainText(/^orchestrator-daemon enroll http:\/\/localhost:\d+ \S+$/);
  await expect(page.getByLabel('Login command')).toHaveText('orchestrator-daemon login');
  await expect(page.getByLabel('Service command')).toHaveText(
    'orchestrator-daemon install-service',
  );
  await expect(page.getByText('Waiting for the machine to enroll…')).toBeVisible();
  await expectFitsScreen(page);

  // The owner types the commands on the machine, then comes back to the page.
  const code = (await enroll.textContent())?.trim().split(' ').pop() ?? '';
  expect(await connectDaemon(page, code)).toBe(204);
  await comeBack(page);
  await expect(page.getByText('Connected: Desktop is ready.')).toBeVisible();
  await page.getByRole('link', { name: 'Open the machine' }).click();

  await expect(page.getByRole('heading', { name: 'Desktop', level: 1 })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Status' })).toHaveText('Online');
  await expect(page.getByText('Windows (WSL)')).toBeVisible();
  const capabilities = page.getByRole('list', { name: 'Capabilities' });
  await expect(capabilities.getByRole('listitem')).toHaveText([
    /git\s*\(detected\)/,
    /node\s*\(detected\)/,
  ]);
  await expectFitsScreen(page);

  await page.getByRole('button', { name: 'Remove node' }).click();
  await expect(capabilities.getByRole('listitem').nth(1)).toHaveText(
    /node\s*\(removed by you, detected\)/,
  );
  await page.getByLabel('Add a capability').fill('Android SDK');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Use lowercase letters and digits')).toBeVisible();
  await page.getByLabel('Add a capability').fill('android-sdk');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(capabilities.getByRole('listitem')).toHaveText([
    /android-sdk\s*\(added by you, not detected\)/,
    /git\s*\(detected\)/,
    /node\s*\(removed by you, detected\)/,
  ]);
  await page.getByRole('button', { name: 'Add back node' }).click();
  await expect(capabilities.getByRole('listitem').nth(2)).toHaveText(/node\s*\(detected\)/);

  await openSection(page, 'Needs you');
  await expect(page.getByText('Nothing needs you right now.')).toBeVisible();

  await openSection(page, 'Machines');
  await expect(page.getByRole('list', { name: 'Machines' })).toContainText('Online');
  await page.getByRole('link', { name: 'Desktop' }).click();
  await page.getByRole('button', { name: 'Revoke' }).click();
  const dialog = page.getByRole('dialog', { name: 'Revoke Desktop?' });
  await expect(dialog).toContainText('disconnected at once');
  await expectFitsScreen(page);
  await dialog.getByRole('button', { name: 'Revoke' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('group', { name: 'Status' })).toHaveText('Revoked');
  await expect(page.getByText('This machine is revoked')).toBeVisible();
  await expect(page.getByLabel('Add a capability')).toBeHidden();

  // A revoked machine brings "No machine enrolled yet" back.
  await openSection(page, 'Needs you');
  await expect(page.getByRole('heading', { level: 2 })).toHaveText(['No machine enrolled yet']);

  // New enrollment code shows the commands again.
  await openSection(page, 'Machines');
  await page.getByRole('link', { name: 'Desktop' }).click();
  await page.getByRole('button', { name: 'New enrollment code' }).click();
  await expect(page.getByRole('group', { name: 'Status' })).toHaveText('Waiting for enrollment');
  await expect(page.getByLabel('Enroll command')).toBeVisible();
});

test('Needs you shows machines that cannot work, with what to do', async ({ page }) => {
  await completeSetup(page);
  const old = await createMachine(page, { name: 'Desktop', account: 'Personal' });
  expect(await connectDaemon(page, old.code, { claudeCodeVersion: '2.0.1' })).toBe(204);
  const outdated = await createMachine(page, { name: 'Laptop', account: 'Personal' });
  expect(await connectDaemon(page, outdated.code, { protocolVersion: 99 })).toBe(409);
  const newer = await createMachine(page, { name: 'Tower', account: 'Personal' });
  expect(await connectDaemon(page, newer.code, { claudeCodeVersion: '9.9.9' })).toBe(204);

  await page.goto('/');
  await expect(page.getByRole('heading', { level: 2 })).toHaveText([
    'Claude Code not supported on Desktop',
    'Update the daemon on Laptop',
  ]);
  await expect(page.getByText('Claude Code 2.0.1 is too old.')).toBeVisible();
  await expect(page.getByLabel('Update command')).toContainText('npm install -g');
  await expect(page.getByLabel('Restart command').first()).toHaveText(
    'systemctl --user restart orchestrator-daemon',
  );
  await expectFitsScreen(page);

  await page.getByRole('link', { name: 'Open the machine' }).first().click();
  await expect(page.getByRole('heading', { name: 'Desktop', level: 1 })).toBeVisible();
  await expect(page.getByText('This machine cannot receive runs:')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Status' })).toContainText('Cannot receive runs');
  await expectFitsScreen(page);

  // A Claude Code newer than the validated one is only a warning, on the machine page.
  await page.goto(`/machines/${newer.id}`);
  await expect(page.getByText('This version is newer than')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Status' })).toHaveText('Online');
});

test('the machine list and page show its active runs, and each account its state', async ({
  page,
}) => {
  await page.goto(await readyForRuns(page));
  const runId = await runNow(page);
  await startRun(page, runId);

  await openSection(page, 'Machines');
  await expect(page.getByRole('list', { name: 'Claude accounts' })).toContainText(
    'State: Available',
  );
  const machine = page.getByRole('list', { name: 'Machines' }).getByRole('listitem').first();
  await expect(machine.getByRole('list', { name: 'Active runs' })).toContainText(
    'WEB-1 · Web Developer · Running',
  );
  await expectFitsScreen(page);

  await machine.getByRole('link', { name: 'Laptop' }).click();
  const runs = page.getByRole('list', { name: 'Active runs' });
  await expect(runs).toContainText('WEB-1 · Web Developer on Laptop');
  await expect(runs.getByLabel('Run status')).toHaveText('Running');
  await expectFitsScreen(page);
});

test('Add machine warns when machines would reach the Orchestrator over plain http://', async ({
  page,
}) => {
  await completeSetup(page);
  const warning = page.getByText(/starts with http:\/\/ and is not this computer/);
  // The test server is on localhost: no warning.
  await page.goto('/machines/new');
  await expect(page.getByRole('heading', { name: 'Add machine' })).toBeVisible();
  await expect(page.getByText('Each machine uses a Claude account.')).toBeVisible();
  await expect(warning).toBeHidden();

  // The server's answer for an address on another computer (checked in the server's tests).
  await page.route('**/api/machines/server-address', (route) =>
    route.fulfill({ json: { address: 'http://192.168.1.20:8080', refusedPlainHttp: true } }),
  );
  await page.reload();
  await expect(warning).toContainText('http://192.168.1.20:8080');
  await expect(page.getByRole('link', { name: 'Orchestrator on another computer' })).toBeVisible();
  await expectFitsScreen(page);
});

test('a daemon to update, and a daemon of another build than the one provided', async ({
  page,
}) => {
  await completeSetup(page);
  // A 0.5.0 daemon: the previous protocol, run from its sources (lot 5 step B).
  const old = await createMachine(page, { name: 'Desktop', account: 'Personal' });
  expect(
    await connectDaemon(page, old.code, {
      protocolVersion: 2,
      daemonVersion: '0.5.0',
      daemonBuild: null,
    }),
  ).toBe(204);
  // A daemon of this protocol, but not the build this Orchestrator provides.
  const other = await createMachine(page, { name: 'Laptop', account: 'Personal' });
  expect(await connectDaemon(page, other.code, { daemonBuild: '0123456789abcdef' })).toBe(204);

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Update the daemon on Desktop' })).toBeVisible();
  await expect(page.getByText(/Daemon 0\.5\.0 is older than this Orchestrator/)).toBeVisible();
  await expect(
    page.getByRole('heading', {
      name: 'The daemon on Laptop is not the one this Orchestrator provides',
    }),
  ).toBeVisible();
  await expect(page.getByText('it may be older or newer')).toBeVisible();
  const commands = page.getByLabel('Update commands');
  await expect(commands).toHaveCount(2);
  await expect(commands.first()).toHaveText(
    new RegExp(
      [
        'systemctl --user stop orchestrator-daemon',
        'npm uninstall -g orchestrator-daemon',
        'npm install -g --prefer-online http://localhost:\\d+/downloads/orchestrator-daemon-[\\d.]+\\.tgz',
        'orchestrator-daemon install-service',
        'orchestrator-daemon doctor',
      ].join('\\n'),
    ),
  );
  await expectFitsScreen(page);

  await page.goto(`/machines/${old.id}`);
  await expect(page.getByRole('heading', { name: 'Desktop', level: 1 })).toBeVisible();
  await expect(page.getByText('Daemon to update')).toBeVisible();
  await expect(page.getByText('None (run from its sources)')).toBeVisible();
  await expect(
    page.getByText(/Update the daemon to [\d.]+: the machine receives no runs until then\./),
  ).toBeVisible();
  await expect(page.getByLabel('Update commands')).toBeVisible();
  await expectFitsScreen(page);

  await page.goto(`/machines/${other.id}`);
  await expect(page.getByRole('heading', { name: 'Laptop', level: 1 })).toBeVisible();
  await expect(page.getByText('Another daemon build')).toBeVisible();
  await expect(page.getByText('0123456789abcdef')).toBeVisible();
  await expect(page.getByText('e2e0e2e0e2e0e2e0')).toBeVisible();
  await expect(page.getByText(/another build, older or newer/)).toBeVisible();
  await expect(page.getByText('This machine cannot receive runs')).toBeHidden();
  await expectFitsScreen(page);
});

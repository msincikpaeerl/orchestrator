import { PLAYWRIGHT_VERSION } from '@orchestrator/protocol';

// The daemon's own Playwright install (`~/.orchestrator/playwright/`, 05 section 8): the
// registered owner of its Chromium. Playwright deletes every browser in `PLAYWRIGHT_BROWSERS_PATH`
// that no install still on disk lists (its `.links` folder), so the owner must be a folder nothing
// else cleans, unlike npx's cache. Written by `orchestrator-daemon browsers`, then installed with
// `npm ci`: the exact files npm published, checked against the integrity below. The lock was made
// by `npm install --package-lock-only` and is checked against `pnpm-lock.yaml` by its test.

const NAME = 'orchestrator-playwright';

export const PLAYWRIGHT_PACKAGE = {
  name: NAME,
  private: true,
  dependencies: { playwright: PLAYWRIGHT_VERSION },
};

export const PLAYWRIGHT_LOCK = {
  name: NAME,
  lockfileVersion: 3,
  requires: true,
  packages: {
    '': { name: NAME, dependencies: { playwright: PLAYWRIGHT_VERSION } },
    'node_modules/playwright': {
      version: '1.64.1',
      resolved: 'https://registry.npmjs.org/playwright/-/playwright-1.64.1.tgz',
      integrity:
        'sha512-HCrVhHr5QQuwYoswEUGTb7gGp522yflbv/ST8nF4sFWGuLjQCt17Q/EubpGGSNKYn1tsTCPZxqHhHCfVURu7UA==',
      license: 'Apache-2.0',
      dependencies: { 'playwright-core': '1.64.1' },
      bin: { playwright: 'cli.js' },
      engines: { node: '>=20' },
    },
    'node_modules/playwright-core': {
      version: '1.64.1',
      resolved: 'https://registry.npmjs.org/playwright-core/-/playwright-core-1.64.1.tgz',
      integrity:
        'sha512-BC4s8y6SEVA6Q1rSxZTto8hI1KUI3xXlHGZgvGqP4IqPdI/a6FX9H29IDNz7vKo9l21b6LfYosScPL6M3xxyDQ==',
      license: 'Apache-2.0',
      bin: { 'playwright-core': 'cli.js' },
      engines: { node: '>=20' },
    },
  },
};

import { expect, it } from 'vitest';
import { DB_PACKAGE } from './index.js';

it('exports the package name', () => {
  expect(DB_PACKAGE).toBe('@orchestrator/db');
});

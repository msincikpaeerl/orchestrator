import { expect, it } from 'vitest';
import { WEB_APP } from './index.js';

it('exports the package name', () => {
  expect(WEB_APP).toBe('@orchestrator/web');
});

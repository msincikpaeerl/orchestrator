import { expect, it } from 'vitest';
import { DAEMON_APP } from './index.js';

it('exports the package name', () => {
  expect(DAEMON_APP).toBe('@orchestrator/daemon');
});

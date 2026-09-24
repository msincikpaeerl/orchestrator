import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from './version.js';

describe('PROTOCOL_VERSION', () => {
  it('is version 1, introduced by lot 2 (09, section 6)', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});

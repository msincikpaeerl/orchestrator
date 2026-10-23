import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from './version.js';

describe('PROTOCOL_VERSION', () => {
  it('is version 2, introduced by lot 3 (09, section 6)', () => {
    expect(PROTOCOL_VERSION).toBe(3);
  });
});

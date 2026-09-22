import { describe, expect, it } from 'vitest';
import { HealthResponse, VersionResponse } from './system.js';

describe('HealthResponse', () => {
  it('accepts a healthy and an unhealthy report', () => {
    expect(HealthResponse.parse({ status: 'ok', database: 'ok' })).toEqual({
      status: 'ok',
      database: 'ok',
    });
    expect(HealthResponse.safeParse({ status: 'error', database: 'error' }).success).toBe(true);
  });

  it('rejects unknown states', () => {
    expect(HealthResponse.safeParse({ status: 'fine', database: 'ok' }).success).toBe(false);
  });
});

describe('VersionResponse', () => {
  it('requires a server version and a positive integer protocol version', () => {
    expect(VersionResponse.safeParse({ server: '0.0.0', protocol: 1 }).success).toBe(true);
    expect(VersionResponse.safeParse({ server: '', protocol: 1 }).success).toBe(false);
    expect(VersionResponse.safeParse({ server: '0.0.0', protocol: 1.5 }).success).toBe(false);
  });
});

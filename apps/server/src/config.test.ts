import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

const validEnv = {
  DATABASE_URL: 'postgres://orchestrator:db-password@postgres:5432/orchestrator',
  ORCHESTRATOR_SECRET_KEY: 'k'.repeat(44),
  PUBLIC_URL: 'http://localhost:8080',
};

describe('loadConfig', () => {
  it('reads the variables and applies the defaults', () => {
    expect(loadConfig(validEnv)).toEqual({
      databaseUrl: validEnv.DATABASE_URL,
      secretKey: validEnv.ORCHESTRATOR_SECRET_KEY,
      publicUrl: 'http://localhost:8080',
      port: 8080,
      logLevel: 'info',
    });
  });

  it('reads the port and log level when given', () => {
    const config = loadConfig({ ...validEnv, PORT: '3000', LOG_LEVEL: 'debug' });
    expect(config.port).toBe(3000);
    expect(config.logLevel).toBe('debug');
  });

  it('names every missing variable', () => {
    expect(() => loadConfig({ ORCHESTRATOR_SECRET_KEY: '' })).toThrow(
      new ConfigError(
        'Invalid configuration (see .env.example):\n' +
          '- DATABASE_URL: missing\n' +
          '- ORCHESTRATOR_SECRET_KEY: missing\n' +
          '- PUBLIC_URL: missing',
      ),
    );
  });

  it('explains invalid values without printing them', () => {
    const secret = 'too-short-secret';
    let message = '';
    try {
      loadConfig({
        ...validEnv,
        DATABASE_URL: 'mysql://root:db-password@db/x',
        ORCHESTRATOR_SECRET_KEY: secret,
        PORT: '70000',
        LOG_LEVEL: 'loud',
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('- DATABASE_URL: must be a postgres:// URL');
    expect(message).toContain('- ORCHESTRATOR_SECRET_KEY: must be at least 32 characters');
    expect(message).toContain('- PORT: ');
    expect(message).toContain('- LOG_LEVEL: ');
    expect(message).not.toContain(secret);
    expect(message).not.toContain('db-password');
    expect(message).not.toContain('loud');
  });
});

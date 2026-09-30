import { describe, expect, it } from 'vitest';
import { isLoopback, isRefusedPlainHttp } from './server-address.js';

describe('server address', () => {
  it('knows the loopback hosts', () => {
    for (const host of ['localhost', 'LOCALHOST', '[::1]', '::1', '127.0.0.1', '127.1.2.3']) {
      expect(isLoopback(host), host).toBe(true);
    }
    for (const host of ['127.example.net', '192.168.0.1', '127.0.0.256', 'example.com', '::2']) {
      expect(isLoopback(host), host).toBe(false);
    }
  });

  it('refuses plain http only outside this computer', () => {
    expect(isRefusedPlainHttp('http://192.168.1.20:8080')).toBe(true);
    expect(isRefusedPlainHttp('http://orchestrator.home')).toBe(true);
    expect(isRefusedPlainHttp('http://localhost:8080')).toBe(false);
    expect(isRefusedPlainHttp('http://127.0.0.1:8080')).toBe(false);
    expect(isRefusedPlainHttp('http://[::1]:8080')).toBe(false);
    expect(isRefusedPlainHttp('https://orchestrator.home')).toBe(false);
  });
});

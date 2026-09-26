import { describe, expect, it } from 'vitest';
import { isLoopback, parseServerUrl, webSocketUrl } from './server-url.js';

describe('the server address (05, section 3.2)', () => {
  it.each([
    'http://localhost:8080',
    'http://127.0.0.1:8080',
    'http://127.4.5.6',
    'http://[::1]:8080',
  ])('accepts plain http on this computer: %s', (url) => {
    expect(parseServerUrl(url)).toBe(url);
  });

  it.each([
    'http://192.168.1.10:8080',
    'http://10.0.0.2',
    'http://100.101.102.103',
    'http://orchestrator.lan',
  ])('refuses plain http elsewhere, saying why: %s', (url) => {
    expect(() => parseServerUrl(url)).toThrow(/https:\/\/.*machine's key.*GitHub token/);
  });

  it('accepts https anywhere and drops a trailing slash', () => {
    expect(parseServerUrl('https://orchestrator.example.net/')).toBe(
      'https://orchestrator.example.net',
    );
    expect(parseServerUrl('https://example.net/orchestrator/')).toBe(
      'https://example.net/orchestrator',
    );
  });

  it('refuses other schemes, non-addresses and credentials in the address', () => {
    expect(() => parseServerUrl('ftp://localhost')).toThrow(/https/);
    expect(() => parseServerUrl('localhost:8080')).toThrow();
    expect(() => parseServerUrl('not an address')).toThrow(/not an address/);
    expect(() => parseServerUrl('https://user:secret@example.net')).toThrow(/user/);
  });

  it('knows the loopback hosts', () => {
    expect(isLoopback('localhost')).toBe(true);
    expect(isLoopback('[::1]')).toBe(true);
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('127.example.net')).toBe(false);
    expect(isLoopback('192.168.0.1')).toBe(false);
  });

  it('gives the WebSocket address', () => {
    expect(webSocketUrl('http://localhost:8080')).toBe('ws://localhost:8080/daemon');
    expect(webSocketUrl('https://example.net/o')).toBe('wss://example.net/o/daemon');
  });
});

import { isIP } from 'node:net';
import { DAEMON_SOCKET_PATH } from '@orchestrator/protocol';
import { UserError } from './errors.js';

/** `localhost`, `127.0.0.0/8` or `::1`: the only hosts reached over plain `http://` (05, section 3.2). */
export function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  if (host === 'localhost' || host === '::1') return true;
  return isIP(host) === 4 && host.startsWith('127.');
}

/**
 * The Orchestrator's address as typed in `enroll`, without a trailing `/`. Plain `http://` is
 * refused unless the server is on this computer (05, section 3.2).
 */
export function parseServerUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UserError(
      `"${input}" is not an address. Copy the enroll command shown by the Orchestrator.`,
    );
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new UserError(
      `The Orchestrator's address must start with https:// (got ${url.protocol}//).`,
    );
  }
  if (url.protocol === 'http:' && !isLoopback(url.hostname)) {
    throw new UserError(
      `The Orchestrator's address must start with https:// when it is on another computer: the machine's key and, for Git commands, your GitHub token travel on this connection, and http:// would send them unencrypted. Put the Orchestrator behind a reverse proxy with HTTPS (Help > Machines > Orchestrator on another computer).`,
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new UserError('The Orchestrator\'s address must not contain a user, a "?" or a "#".');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** The daemon's WebSocket address for a server address checked by `parseServerUrl`. */
export function webSocketUrl(serverUrl: string): string {
  return `${serverUrl.replace(/^http/, 'ws')}${DAEMON_SOCKET_PATH}`;
}

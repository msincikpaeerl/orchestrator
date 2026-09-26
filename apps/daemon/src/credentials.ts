import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, rm } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';
import {
  CredentialSocketAnswer,
  CredentialSocketRequest,
  type GitCredentialRequest,
} from '@orchestrator/protocol';
import type { Logger } from 'pino';
import { safeJson } from './config.js';
import { shellCommand } from './self.js';

// The GitHub credential for one Git command (05, section 7). The token lives only in the daemon's
// memory for that command: Git gets it through a credential helper given on the command's line,
// which asks a one-shot socket of the daemon for it. It is never written to a file, a Git
// configuration or a remote URL.

/** The credential for one command, asked from the server (`git.credential_request`). */
export type CredentialSource = (
  request: GitCredentialRequest['payload'],
) => Promise<{ username: string; password: string } | null>;

const SOCKET_VARIABLE = 'ORCHESTRATOR_CREDENTIAL_SOCKET';
const KEY_VARIABLE = 'ORCHESTRATOR_CREDENTIAL_KEY';

export interface CredentialCommand {
  /** Options to put before Git's command: the owner's helpers reset, then the daemon's. */
  gitOptions: string[];
  /** Variables for that Git command only. */
  env: Record<string, string>;
}

/**
 * Runs `work` with a one-shot credential socket in `folder` (the run folder, mode 700). The socket
 * answers at most one credential, only to a client presenting the key and only for the exact
 * protocol and host of `cloneUrl`; the server is asked only when Git asks. It is removed when
 * `work` ends.
 */
export async function withCredentialHelper<T>(
  options: {
    folder: string;
    cloneUrl: string;
    request: GitCredentialRequest['payload'];
    source: CredentialSource;
    selfCommand: readonly string[];
    log: Logger;
  },
  work: (command: CredentialCommand) => Promise<T>,
): Promise<T> {
  const url = new URL(options.cloneUrl);
  const expected = { protocol: url.protocol.replace(/:$/, ''), host: url.host };
  const key = randomBytes(32).toString('base64url');
  const path = join(options.folder, `git-${randomBytes(8).toString('hex')}.sock`);
  let answered = false;

  const answer = async (line: string): Promise<CredentialSocketAnswer> => {
    const request = CredentialSocketRequest.safeParse(safeJson(line));
    if (!request.success || !sameKey(request.data.key, key)) {
      options.log.warn('credential request with a wrong key: refused');
      return { ok: false };
    }
    const { protocol, host } = request.data;
    if (protocol !== expected.protocol || host !== expected.host || protocol === 'file') {
      options.log.warn(
        { protocol, host, expected },
        "credential refused: Git asked for another protocol or host than the repository's",
      );
      return { ok: false };
    }
    if (answered) return { ok: false };
    answered = true;
    const credential = await options.source(options.request);
    if (!credential) {
      options.log.warn('no credential from the Orchestrator for this command');
      return { ok: false };
    }
    return { ok: true, ...credential };
  };

  const server = createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      socket.pause();
      void answer(buffer.slice(0, end)).then(
        (result) => socket.end(`${JSON.stringify(result)}\n`),
        () => socket.end(`${JSON.stringify({ ok: false })}\n`),
      );
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  await chmod(path, 0o600);
  try {
    return await work({
      gitOptions: [
        '-c',
        'credential.helper=',
        '-c',
        `credential.helper=!${shellCommand([...options.selfCommand, 'git-credential'])}`,
      ],
      env: { [SOCKET_VARIABLE]: path, [KEY_VARIABLE]: key },
    });
  } finally {
    server.close();
    await rm(path, { force: true });
  }
}

function sameKey(given: string, key: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * `orchestrator-daemon git-credential <operation>`: the helper Git runs (internal, 05 section 7).
 * For `get`, it passes the protocol and host Git asks for to the one-shot socket and prints the
 * credential it answers; it prints nothing otherwise, so Git fails without prompting.
 */
export async function gitCredentialHelper(
  operation: string,
  input: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const socket = env[SOCKET_VARIABLE];
  const key = env[KEY_VARIABLE];
  if (operation !== 'get' || !socket || !key) return '';
  const fields = new Map<string, string>();
  for (const line of input.split('\n')) {
    const separator = line.indexOf('=');
    if (separator > 0) fields.set(line.slice(0, separator), line.slice(separator + 1));
  }
  const request: CredentialSocketRequest = {
    key,
    protocol: fields.get('protocol') ?? '',
    host: fields.get('host') ?? '',
  };
  const text = await new Promise<string>((resolve) => {
    const connection = createConnection(socket);
    let received = '';
    connection.setEncoding('utf8');
    connection.on('connect', () => connection.write(`${JSON.stringify(request)}\n`));
    connection.on('data', (chunk: string) => (received += chunk));
    connection.on('end', () => {
      resolve(received);
    });
    connection.on('error', () => {
      resolve('');
    });
  });
  const answer = CredentialSocketAnswer.safeParse(safeJson(text.trim()));
  if (!answer.success || !answer.data.ok) return '';
  return `username=${answer.data.username}\npassword=${answer.data.password}\n`;
}

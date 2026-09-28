import {
  STREAM_KEEP_ALIVE_MS,
  STREAM_PATH,
  STREAM_RETRY_MS,
  type StreamMessage,
} from '@orchestrator/protocol';
import type { FastifyInstance } from 'fastify';
import { requireSession } from '../auth/routes.js';
import { findSession, SESSION_COOKIE } from '../auth/sessions.js';
import type { Database } from '../database.js';
import type { ChangeFeed } from './changes.js';

/**
 * `GET /api/stream` (02, section 1; 09, section 4): Server-Sent Events carrying the change
 * feed's messages to a logged-in browser. The stream ends when its session does: at logout (a
 * `session` change) or, at the latest, at the next keep-alive after the session expired or was
 * revoked. The browser then reconnects, is refused, and shows the login page.
 */
export function registerStreamRoute(
  app: FastifyInstance,
  {
    db,
    feed,
    keepAliveMs = STREAM_KEEP_ALIVE_MS,
  }: {
    db: Database;
    feed: ChangeFeed;
    keepAliveMs?: number;
  },
) {
  const open = new Set<() => void>();
  // Open streams would keep the server from closing.
  app.addHook('preClose', (done) => {
    for (const end of [...open]) end();
    done();
  });

  app.get(STREAM_PATH, async (request, reply) => {
    await requireSession(db, request);
    const token = request.cookies[SESSION_COOKIE] ?? '';
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Proxies such as nginx would otherwise hold the messages back.
      'x-accel-buffering': 'no',
    });
    raw.write(`retry: ${String(STREAM_RETRY_MS)}\n\n`);

    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      clearInterval(keepAlive);
      unsubscribe();
      open.delete(end);
      raw.end();
    };
    const checkSession = () => {
      findSession(db, token)
        .then((session) => {
          if (!session) end();
        })
        .catch((error: unknown) => {
          request.log.warn({ err: error }, 'realtime: session check failed');
        });
    };
    const send = (message: StreamMessage) => {
      if (!ended) raw.write(`data: ${JSON.stringify(message)}\n\n`);
    };
    const unsubscribe = feed.subscribe((message) => {
      if (message.type === 'changed' && message.entity === 'session') checkSession();
      send(message);
    });
    const keepAlive = setInterval(() => {
      if (!ended) raw.write(': keep-alive\n\n');
      checkSession();
    }, keepAliveMs);
    open.add(end);
    raw.on('close', end);
    request.log.debug('realtime: stream opened');
  });
}

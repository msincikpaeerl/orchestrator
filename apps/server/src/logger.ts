import { pino, type DestinationStream, type Logger } from 'pino';

/**
 * The server's Pino logger (ADR 0013). Secrets are never passed to the logger; the redaction
 * below is a second line of defence for request headers and bodies logged by mistake.
 */
export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
          '*.password',
          '*.token',
        ],
        censor: '[redacted]',
      },
    },
    destination,
  );
}

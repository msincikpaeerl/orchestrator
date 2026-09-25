import { isIP } from 'node:net';
import { connect } from 'node:tls';

/** A certificate expiring within this many days gets a warning in `doctor` (05, section 8). */
export const CERTIFICATE_WARNING_DAYS = 14;

export type CertificateResult =
  | { kind: 'valid'; validTo: Date }
  | { kind: 'untrusted'; reason: string }
  | { kind: 'unreachable'; reason: string };

/** Error codes of a TLS connection refused because of the certificate, not the network. */
function isCertificateError(code: string | undefined): boolean {
  return (
    code !== undefined &&
    (/CERT|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)|DEPTH_ZERO/.test(code) ||
      code === 'ERR_TLS_CERT_ALTNAME_INVALID')
  );
}

/**
 * Opens a TLS connection to an `https://` server with the same trust as the daemon (the system's
 * authorities, or the `--ca-file` one) and reads its certificate. Checks are never disabled.
 */
export function checkCertificate(
  serverUrl: string,
  ca: string | null,
  timeoutMs = 5000,
): Promise<CertificateResult> {
  const url = new URL(serverUrl);
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  return new Promise((resolve) => {
    const socket = connect({
      host,
      port: Number(url.port || 443),
      ...(isIP(host) === 0 ? { servername: host } : {}),
      ...(ca ? { ca } : {}),
      timeout: timeoutMs,
    });
    socket.once('secureConnect', () => {
      const certificate = socket.getPeerCertificate();
      socket.end();
      resolve({ kind: 'valid', validTo: new Date(certificate.valid_to) });
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve({ kind: 'unreachable', reason: 'no answer' });
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      socket.destroy();
      resolve(
        isCertificateError(error.code)
          ? { kind: 'untrusted', reason: error.message }
          : { kind: 'unreachable', reason: error.code ?? error.message },
      );
    });
  });
}

/**
 * `localhost`, `127.0.0.0/8` or `::1`: the only hosts a daemon reaches over plain `http://`
 * (05, section 3.2). Shared by the daemon, which refuses any other plain `http://` address, and by
 * **Add machine**, which warns about it (02, section 9.2).
 */
export function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  if (host === 'localhost' || host === '::1') return true;
  const parts = host.split('.');
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

/** Whether a daemon refuses this server address: plain `http://` outside this computer. */
export function isRefusedPlainHttp(address: string): boolean {
  const url = new URL(address);
  return url.protocol === 'http:' && !isLoopback(url.hostname);
}

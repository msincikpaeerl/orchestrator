import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { ApiError, EnrollResponse, EnrollmentCode } from '@orchestrator/protocol';
import { safeJson, writeConfig } from './config.js';
import { probeControl } from './control.js';
import { UserError } from './errors.js';
import { clearLastStop } from './last-stop.js';
import type { DaemonPaths } from './paths.js';
import { parseServerUrl } from './server-url.js';

/** POST of a JSON body, with the `--ca-file` authority for `https://`; the status and body. */
function postJson(
  url: string,
  body: unknown,
  ca: string | null,
): Promise<{ status: number; body: unknown }> {
  const data = JSON.stringify(body);
  const request = url.startsWith('https:') ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const outgoing = request(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
        timeout: 15_000,
        ...(ca ? { ca } : {}),
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (text += chunk));
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, body: safeJson(text) });
        });
      },
    );
    outgoing.on('timeout', () => outgoing.destroy(new Error('no answer within 15 seconds')));
    outgoing.on('error', reject);
    outgoing.end(data);
  });
}

async function readCa(path: string): Promise<string> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new UserError(`Cannot read the certificate file ${path}: ${(error as Error).message}`);
  }
  if (!text.includes('-----BEGIN CERTIFICATE-----')) {
    throw new UserError(`${path} is not a PEM certificate (it has no "BEGIN CERTIFICATE" line).`);
  }
  return text;
}

/**
 * `orchestrator-daemon enroll <url> <code> [--ca-file <path>]` (05, section 3.1): exchanges the
 * one-time code for the machine token and stores it in `config.json` (mode 600).
 */
export async function enroll(
  paths: DaemonPaths,
  input: { url: string; code: string; caFile?: string },
  out: (line: string) => void,
): Promise<void> {
  const serverUrl = parseServerUrl(input.url);
  const code = EnrollmentCode.safeParse(input.code);
  if (!code.success) {
    throw new UserError(
      `"${input.code}" is not an enrollment code: copy the enroll command shown by the Orchestrator.`,
    );
  }
  const ca = input.caFile ? await readCa(input.caFile) : null;

  let answer: { status: number; body: unknown };
  try {
    answer = await postJson(`${serverUrl}/daemon/enroll`, { code: code.data }, ca);
  } catch (error) {
    throw new UserError(
      `Cannot reach the Orchestrator at ${serverUrl}: ${(error as Error).message}. Check the address, and that the Orchestrator is running.`,
    );
  }
  if (answer.status !== 200) {
    const refusal = ApiError.safeParse(answer.body);
    throw new UserError(
      refusal.success
        ? `The Orchestrator refused the enrollment: ${refusal.data.error.message}`
        : `The Orchestrator answered HTTP ${String(answer.status)}: is ${serverUrl} the Orchestrator's address?`,
    );
  }
  const enrolled = EnrollResponse.safeParse(answer.body);
  if (!enrolled.success) {
    throw new UserError(
      `The Orchestrator's answer was not understood: is ${serverUrl} its address?`,
    );
  }
  await writeConfig(paths.config, {
    serverUrl,
    machineId: enrolled.data.machineId,
    machineName: enrolled.data.machineName,
    machineToken: enrolled.data.machineToken,
    ca,
  });
  await clearLastStop(paths.lastStop);
  out(`This computer is enrolled as the machine "${enrolled.data.machineName}".`);
  const running = await probeControl(paths.controlSocket);
  if (running.kind === 'running') {
    out(
      running.status.mode === 'service'
        ? 'A daemon is running with the previous key: restart it with "systemctl --user restart orchestrator-daemon".'
        : 'A daemon is running in a terminal with the previous key: stop it with Ctrl+C and start it again.',
    );
  } else {
    out('Next: type "orchestrator-daemon login", then "orchestrator-daemon install-service".');
  }
}

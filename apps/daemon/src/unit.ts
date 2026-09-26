import { isAbsolute } from 'node:path';
import { EXIT_REFUSED } from './errors.js';

/**
 * The service's `PATH` (05, section 2): the terminal's, without empty or relative entries (`.`
 * included) and, on WSL, without the Windows folders under `/mnt/` added by WSL interop.
 */
export function servicePath(pathValue: string | undefined, wsl: boolean): string {
  const kept: string[] = [];
  for (const entry of (pathValue ?? '').split(':')) {
    if (!entry || !isAbsolute(entry)) continue;
    if (wsl && (entry === '/mnt' || entry.startsWith('/mnt/'))) continue;
    if (!kept.includes(entry)) kept.push(entry);
  }
  return kept.join(':');
}

export interface UnitValues {
  /** Absolute path of the `node` running `install-service`. */
  node: string;
  /** Absolute path of the daemon's script. */
  script: string;
  path: string;
  /** `ORCHESTRATOR_HOME` when it is set at install time. */
  orchestratorHome: string | undefined;
}

/** A value inside double quotes in a unit file: `%` is a specifier, `"` and `\` are escaped. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
}

function unquote(value: string): string {
  return value.replace(/%%/g, '%').replace(/\\(["\\])/g, '$1');
}

/** The systemd user unit `orchestrator-daemon` (05, section 2). */
export function unitText(values: UnitValues): string {
  const environment = [`Environment=${quote(`PATH=${values.path}`)}`];
  if (values.orchestratorHome) {
    environment.push(`Environment=${quote(`ORCHESTRATOR_HOME=${values.orchestratorHome}`)}`);
  }
  return `# Written by "orchestrator-daemon install-service". Type that command again after
# installing a tool or changing the Node.js version, instead of editing this file.
[Unit]
Description=Orchestrator daemon

[Service]
Type=simple
ExecStart=${quote(values.node)} ${quote(values.script)} start --service
${environment.join('\n')}
Restart=on-failure
RestartSec=5
# A refusal that retrying cannot fix (revoked, incompatible, replaced): see the last stop reason.
RestartPreventExitStatus=${String(EXIT_REFUSED)}

[Install]
WantedBy=default.target
`;
}

/** What `doctor` reads back from an installed unit. */
export interface InstalledUnit {
  node: string | null;
  path: string | null;
}

export function parseUnit(text: string): InstalledUnit {
  const quoted = /"((?:[^"\\]|\\.)*)"/g;
  let node: string | null = null;
  let path: string | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('ExecStart=')) {
      const first = quoted.exec(line.slice('ExecStart='.length));
      quoted.lastIndex = 0;
      if (first?.[1] !== undefined) node = unquote(first[1]);
    }
    if (line.startsWith('Environment=')) {
      const value = quoted.exec(line.slice('Environment='.length));
      quoted.lastIndex = 0;
      const assignment = value?.[1] === undefined ? '' : unquote(value[1]);
      if (assignment.startsWith('PATH=')) path = assignment.slice('PATH='.length);
    }
  }
  return { node, path };
}

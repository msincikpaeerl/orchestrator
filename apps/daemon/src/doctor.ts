import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CLAUDE_CODE_MIN_VERSION,
  CLAUDE_CODE_VALIDATED_VERSION,
  claudeCodeSupport,
  type DoctorCheck,
} from '@orchestrator/protocol';
import { checkBrowsers, describeBrowsers } from './browsers.js';
import { CERTIFICATE_WARNING_DAYS, checkCertificate } from './certificate.js';
import { readConfig, type DaemonConfig } from './config.js';
import { findExecutable, runCommand } from './exec.js';
import type { DaemonPaths } from './paths.js';
import { parseUnit } from './unit.js';

// `doctor` (05, section 8): the checks run at each `hello` and by the `doctor` command, graded
// as in the spec's table. An error makes the machine unusable; a warning is shown only.

/** Minimum versions of Git and tmux (05, section 2). */
export const GIT_MINIMUM: readonly [number, number] = [2, 40];
export const TMUX_MINIMUM: readonly [number, number] = [3, 2];

/** Where the checks look; tests point every part to temporary folders and fake executables. */
export interface DoctorEnvironment {
  paths: DaemonPaths;
  /** The PATH the daemon runs with: where `git`, `tmux`, `claude`, `node` and `npm` are looked up. */
  toolPath: string;
  /** Names that PATH in messages: "the service's PATH", "the daemon's PATH". */
  toolPathLabel: string;
  /** The PATH used to find `systemctl` and `loginctl`. */
  systemPath: string;
  /** The `node` running this process. */
  nodePath: string;
  wsl: boolean;
  /** Folders of managed Claude Code settings (`/etc/claude-code`, and the Windows one on WSL). */
  managedSettingsDirs: string[];
  username: string;
}

export interface DoctorResult {
  checks: DoctorCheck[];
  /** `claude --version`, for `hello`; null when missing or unreadable. */
  claudeCodeVersion: string | null;
  /** The **Browser tests** check passed: the machine detects `browser-tests` (01, section 3.8). */
  browserTests: boolean;
}

const MANAGED_FILES = ['managed-settings.json', 'managed-mcp.json'];

function check(
  name: string,
  status: DoctorCheck['status'],
  message: string,
  link: string | null = null,
): DoctorCheck {
  return { name, status, message, link };
}

/** `2.53.0` from `git version 2.53.0`, `3.6` from `tmux 3.6a` or `tmux next-3.6`. */
function versionIn(text: string): [number, number, string] | null {
  const match = /(\d+)\.(\d+)(\.\d+)?/.exec(text);
  if (!match?.[1] || !match[2]) return null;
  return [Number(match[1]), Number(match[2]), match[0]];
}

function atLeast(version: [number, number, string], minimum: readonly [number, number]): boolean {
  return version[0] > minimum[0] || (version[0] === minimum[0] && version[1] >= minimum[1]);
}

/** Help pages of the Orchestrator the machine is enrolled with. */
export function helpLink(config: DaemonConfig | null, section: string): string | null {
  return config ? `${config.serverUrl}/help/machines#${section}` : null;
}

/**
 * `processScopes`: the running daemon's process scopes check (05, section 8), from itself or,
 * for the `doctor` command, from its control socket; null when there is none to show.
 */
export async function runDoctor(
  environment: DoctorEnvironment,
  processScopes: DoctorCheck | null = null,
): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  let config: DaemonConfig | null = null;
  try {
    config = await readConfig(environment.paths.config);
    if (!config) {
      checks.push(
        check(
          'Enrollment',
          'error',
          'Not enrolled: type the "orchestrator-daemon enroll ..." command shown by the Orchestrator when you added the machine.',
        ),
      );
    }
  } catch (error) {
    checks.push(check('Enrollment', 'error', (error as Error).message));
  }

  if (config) checks.push(...(await serverChecks(config)));
  const tools = await toolChecks(environment, config);
  checks.push(...tools.checks);
  const browsers = await browserCheck(environment, config);
  checks.push(browsers);
  checks.push(loginCheck(environment));
  checks.push(...(await serviceChecks(environment, config)));
  if (processScopes) checks.push(processScopes);
  checks.push(managedSettingsCheck(environment));
  if (environment.wsl) {
    checks.push(check('WSL', 'ok', 'WSL detected'));
    checks.push(
      check(
        'WSL idle timeout',
        'check_yourself',
        'The daemon cannot read Windows files: check that %UserProfile%\\.wslconfig has instanceIdleTimeout=-1 under [general], so Windows does not stop WSL while the daemon runs.',
        helpLink(config, 'keep-wsl-running'),
      ),
    );
  }
  return {
    checks,
    claudeCodeVersion: tools.claudeCodeVersion,
    browserTests: browsers.status === 'ok',
  };
}

/** A warning, never an error: a machine without it takes every run that does not need it. */
async function browserCheck(
  environment: DoctorEnvironment,
  config: DaemonConfig | null,
): Promise<DoctorCheck> {
  const state = await checkBrowsers(environment.paths.browsers, environment.toolPath);
  return state.kind === 'ok'
    ? check('Browser tests', 'ok', describeBrowsers(state))
    : check('Browser tests', 'warning', describeBrowsers(state), helpLink(config, 'browser-tests'));
}

async function serverChecks(config: DaemonConfig): Promise<DoctorCheck[]> {
  const url = config.serverUrl;
  if (url.startsWith('http:')) {
    return [check('Server address', 'ok', `${url}: this computer only (http)`)];
  }
  const checks = [check('Server address', 'ok', `${url}: encrypted (https)`)];
  const result = await checkCertificate(url, config.ca);
  const link = helpLink(config, 'orchestrator-on-another-computer');
  if (result.kind === 'untrusted') {
    checks.push(
      check(
        'Server certificate',
        'error',
        `Not trusted: ${result.reason}. If the Orchestrator uses its own certificate authority, enroll again with --ca-file.`,
        link,
      ),
    );
  } else if (result.kind === 'unreachable') {
    checks.push(
      check(
        'Server certificate',
        'warning',
        `Could not be checked: the Orchestrator cannot be reached (${result.reason}).`,
      ),
    );
  } else {
    const days = (result.validTo.getTime() - Date.now()) / 86_400_000;
    const date = result.validTo.toISOString().slice(0, 10);
    checks.push(
      days < CERTIFICATE_WARNING_DAYS
        ? check(
            'Server certificate',
            'warning',
            `Valid, but expires on ${date}: renew it before then, or the daemon cannot connect.`,
            link,
          )
        : check('Server certificate', 'ok', `Valid until ${date}`),
    );
  }
  return checks;
}

async function toolVersion(
  environment: DoctorEnvironment,
  executable: string,
  args: string[],
): Promise<string> {
  const result = await runCommand(executable, args, {
    env: { ...process.env, PATH: environment.toolPath },
  });
  return result ? `${result.stdout}\n${result.stderr}`.trim() : '';
}

async function toolChecks(
  environment: DoctorEnvironment,
  config: DaemonConfig | null,
): Promise<{ checks: DoctorCheck[]; claudeCodeVersion: string | null }> {
  const checks: DoctorCheck[] = [];
  const where = environment.toolPathLabel;
  const prerequisites = helpLink(config, 'before-you-start');
  const notFound = (tool: string) =>
    `${tool} not found in ${where}. Install it, then type "orchestrator-daemon install-service" again from a terminal where it works.`;

  for (const [name, command, minimum, args] of [
    ['Git', 'git', GIT_MINIMUM, ['--version']],
    ['tmux', 'tmux', TMUX_MINIMUM, ['-V']],
  ] as const) {
    const executable = findExecutable(command, environment.toolPath);
    if (!executable) {
      checks.push(check(name, 'error', notFound(name), prerequisites));
      continue;
    }
    const version = versionIn(await toolVersion(environment, executable, [...args]));
    const wanted = `${String(minimum[0])}.${String(minimum[1])}`;
    if (!version) {
      checks.push(check(name, 'error', `${name}'s version could not be read.`, prerequisites));
    } else if (!atLeast(version, minimum)) {
      checks.push(
        check(
          name,
          'error',
          `${name} ${version[2]} is older than ${wanted}: update it.`,
          prerequisites,
        ),
      );
    } else {
      checks.push(check(name, 'ok', `${name} ${version[2]}`));
    }
  }

  let claudeCodeVersion: string | null = null;
  const claude = findExecutable('claude', environment.toolPath);
  if (!claude) {
    checks.push(check('Claude Code', 'error', notFound('Claude Code (claude)'), prerequisites));
  } else {
    claudeCodeVersion =
      /^(\d+\.\d+\.\d+)/.exec(await toolVersion(environment, claude, ['--version']))?.[1] ?? null;
    const support = claudeCodeSupport(claudeCodeVersion);
    if (support === 'missing') {
      checks.push(
        check('Claude Code', 'error', "Claude Code's version could not be read.", prerequisites),
      );
    } else if (support === 'below_minimum') {
      checks.push(
        check(
          'Claude Code',
          'error',
          `Claude Code ${String(claudeCodeVersion)} is older than ${CLAUDE_CODE_MIN_VERSION}: update it (type "claude update").`,
          prerequisites,
        ),
      );
    } else if (support === 'above_validated') {
      checks.push(
        check(
          'Claude Code',
          'warning',
          `Claude Code ${String(claudeCodeVersion)} is newer than ${CLAUDE_CODE_VALIDATED_VERSION}, the latest version checked with this Orchestrator. Runs are still allowed.`,
        ),
      );
    } else {
      checks.push(check('Claude Code', 'ok', `Claude Code ${String(claudeCodeVersion)}`));
    }
  }

  for (const [name, command] of [
    ['Node.js', 'node'],
    ['npm', 'npm'],
  ] as const) {
    checks.push(
      findExecutable(command, environment.toolPath)
        ? check(name, 'ok', `Found in ${where}`)
        : check(
            name,
            'warning',
            `Not found in ${where}: agents cannot run ${command} commands. Type "orchestrator-daemon install-service" again from a terminal where "${command} --version" works.`,
          ),
    );
  }
  return { checks, claudeCodeVersion };
}

/** Only the presence of the login file is checked: the daemon never reads it (05, section 7). */
function loginCheck(environment: DoctorEnvironment): DoctorCheck {
  return existsSync(join(environment.paths.claudeConfig, '.credentials.json'))
    ? check('Claude Code login', 'ok', 'Logged in')
    : check(
        'Claude Code login',
        'error',
        'Not logged in: type "orchestrator-daemon login" and log in with the Claude account of this machine.',
      );
}

async function serviceChecks(
  environment: DoctorEnvironment,
  config: DaemonConfig | null,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const systemctl = findExecutable('systemctl', environment.systemPath);
  const answer = systemctl
    ? (await runCommand(systemctl, ['--user', 'is-system-running']))?.stdout.trim()
    : undefined;
  checks.push(
    answer === 'running'
      ? check('systemd', 'ok', 'Running')
      : check(
          'systemd',
          'warning',
          `systemd does not run for your user (${answer || 'no answer'}): the daemon cannot run as a service.`,
          environment.wsl ? helpLink(config, 'turn-on-systemd-on-wsl') : null,
        ),
  );

  const loginctl = findExecutable('loginctl', environment.systemPath);
  const linger = loginctl
    ? (
        await runCommand(loginctl, [
          'show-user',
          environment.username,
          '--property=Linger',
          '--value',
        ])
      )?.stdout.trim()
    : undefined;
  checks.push(
    linger === 'yes'
      ? check('Lingering', 'ok', 'On: the service runs without an open login')
      : check(
          'Lingering',
          'warning',
          `Off: the service stops when you log out. Type "loginctl enable-linger ${environment.username}".`,
          helpLink(config, 'lingering'),
        ),
  );

  let unitText: string | null;
  try {
    unitText = readFileSync(environment.paths.unit, 'utf8');
  } catch {
    unitText = null;
  }
  if (unitText === null) {
    checks.push(
      check(
        'Service',
        'warning',
        'Not installed: type "orchestrator-daemon install-service" so the daemon runs in the background and starts with the computer.',
      ),
    );
    return checks;
  }
  const unit = parseUnit(unitText);
  const reinstall =
    'Install the daemon again with the npm install -g command shown by the Orchestrator, then type "orchestrator-daemon install-service" again.';
  if (unit.node === null || !existsSync(unit.node)) {
    checks.push(
      check(
        'Service',
        'error',
        `The service starts the daemon with ${unit.node ?? 'a Node.js'} that no longer exists (was Node.js changed?). ${reinstall}`,
        helpLink(config, 'after-changing-the-nodejs-version'),
      ),
    );
  } else if (unit.node !== environment.nodePath) {
    checks.push(
      check(
        'Service',
        'error',
        `The service starts the daemon with ${unit.node}, but this daemon runs with ${environment.nodePath}. ${reinstall}`,
        helpLink(config, 'after-changing-the-nodejs-version'),
      ),
    );
  } else {
    checks.push(check('Service', 'ok', `Installed, with ${unit.node}`));
  }
  return checks;
}

function managedSettingsCheck(environment: DoctorEnvironment): DoctorCheck {
  const found: string[] = [];
  for (const folder of environment.managedSettingsDirs) {
    for (const file of MANAGED_FILES) {
      if (existsSync(join(folder, file))) found.push(join(folder, file));
    }
    const dropIns = join(folder, 'managed-settings.d');
    try {
      if (readdirSync(dropIns).length > 0) found.push(`${dropIns}/`);
    } catch {
      // No drop-in folder.
    }
  }
  return found.length === 0
    ? check('Managed Claude Code settings', 'ok', 'None')
    : check(
        'Managed Claude Code settings',
        'error',
        `Found ${found.join(', ')}: they apply to every run and can change its permissions. Remove them, or use a machine without them.`,
      );
}

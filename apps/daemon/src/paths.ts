import { homedir } from 'node:os';
import { join } from 'node:path';

/** Name of the systemd user unit (05, section 2). */
export const SERVICE_NAME = 'orchestrator-daemon';

/** Name of the daemon's own tmux server (`tmux -L orchestrator`), apart from the owner's (05, section 4.3). */
export const TMUX_SOCKET_NAME = 'orchestrator';

/** The files the daemon manages (05, section 4.2). */
export interface DaemonPaths {
  /** `~/.orchestrator`, or `ORCHESTRATOR_HOME`: tests never touch the real home folder. */
  home: string;
  /** The owner's home folder (`HOME`), whose Claude configuration runs must never reach. */
  userHome: string;
  config: string;
  /** The dedicated `CLAUDE_CONFIG_DIR` (ADR 0002). */
  claudeConfig: string;
  /** The control socket of the running daemon (05, section 8). */
  controlSocket: string;
  lastStop: string;
  /** `~/.config/systemd/user/orchestrator-daemon.service`, or under `XDG_CONFIG_HOME`. */
  unit: string;
}

export function daemonPaths(env: NodeJS.ProcessEnv = process.env): DaemonPaths {
  const home = env.ORCHESTRATOR_HOME || join(homedir(), '.orchestrator');
  const configHome = env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return {
    home,
    userHome: env.HOME || homedir(),
    config: join(home, 'config.json'),
    claudeConfig: join(home, 'claude-config'),
    controlSocket: join(home, 'daemon.sock'),
    lastStop: join(home, 'last-stop.json'),
    unit: join(configHome, 'systemd', 'user', `${SERVICE_NAME}.service`),
  };
}

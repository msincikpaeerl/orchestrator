import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  REASONS,
  REFUSAL_SUFFIX,
  checkBash,
  checkToolCall,
  settingsPermissions,
  type PermissionScope,
} from './permissions.js';

// The `PreToolUse` rules and the settings rules of a run (05, section 4.6): each rule refuses
// with its reason, and ordinary work passes.

const root = mkdtempSync(join(tmpdir(), 'od-perm-'));
const userHome = join(root, 'home');
const daemonHome = join(userHome, '.orchestrator');
const worktree = join(daemonHome, 'worktrees', 'run-1');
mkdirSync(join(worktree, 'src'), { recursive: true });
mkdirSync(join(worktree, '.claude'), { recursive: true });
mkdirSync(join(daemonHome, 'worktrees', 'run-2'), { recursive: true });
mkdirSync(join(daemonHome, 'claude-config'), { recursive: true });
writeFileSync(join(daemonHome, 'config.json'), '{}');
// A link in the worktree to the machine's key: file tools follow it and are refused.
symlinkSync(join(daemonHome, 'config.json'), join(worktree, 'src', 'key.json'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The root folders of a typical Linux or WSL machine: the tests do not depend on the host's. */
const ROOT = new Set([
  'bin',
  'dev',
  'etc',
  'home',
  'lib',
  'lib64',
  'mnt',
  'opt',
  'proc',
  'root',
  'sbin',
  'srv',
  'tmp',
  'usr',
  'var',
]);
const scope: PermissionScope = {
  worktree,
  daemonHome,
  userHome,
  tempDirs: ['/tmp'],
  rootEntryExists: (name) => ROOT.has(name),
};
const bash = (command: string) => checkBash(scope, command);
const tool = (name: string, input: Record<string, unknown>) => checkToolCall(scope, name, input);

describe('settings rules', () => {
  it('allows the profile, ToolSearch and the Orchestrator tools, and denies the protected folders but the worktrees', () => {
    const { allow, deny } = settingsPermissions(scope, ['Bash(pnpm test *)', 'ToolSearch']);
    expect(allow).toEqual(['Bash(pnpm test *)', 'ToolSearch', 'mcp__orchestrator']);
    const paths = [
      `/${daemonHome}/config.json`,
      `/${daemonHome}/daemon.sock`,
      `/${daemonHome}/last-stop.json`,
      `/${daemonHome}/browsers/**`,
      `/${daemonHome}/claude-config/**`,
      `/${daemonHome}/playwright/**`,
      `/${daemonHome}/repos/**`,
      `/${daemonHome}/runs/**`,
      `/${userHome}/.claude/**`,
      `/${userHome}/.claude.json`,
    ];
    const files = deny.filter((rule) => !rule.startsWith('Bash('));
    expect(files).toEqual(paths.flatMap((path) => [`Read(${path})`, `Edit(${path})`]));
    expect(files.every((rule) => rule.includes('(//'))).toBe(true);
    expect(deny.some((rule) => rule.includes('worktrees'))).toBe(false);
  });

  it('denies the container tools, which Claude Code would allow by itself for "docker ps"', () => {
    const { deny } = settingsPermissions(scope, []);
    expect(deny.filter((rule) => rule.startsWith('Bash('))).toEqual(
      ['docker', 'docker-compose', 'podman', 'nerdctl', 'kubectl'].flatMap((name) => [
        `Bash(${name})`,
        `Bash(${name} *)`,
      ]),
    );
  });
});

describe('PreToolUse rules for Bash', () => {
  it('refuses Git commands that talk to a remote, in any form', () => {
    for (const command of [
      'git push',
      'git push origin HEAD',
      'git -C sub push',
      'git -c user.name=x push',
      'git --no-pager fetch origin',
      'git pull --rebase',
      'git clone https://example.org/x.git',
      'git ls-remote origin',
      'git remote add upstream https://example.org/x.git',
      'git remote set-url origin https://example.org/x.git',
      'git send-pack origin',
      'npm test && git push',
      'echo done; git fetch',
      'env GIT_TRACE=1 git push',
      '/usr/bin/git push',
      'timeout 10 git pull',
    ]) {
      expect(bash(command), command).toBe(REASONS.remote);
    }
  });

  it('refuses gh, hub and commands naming a GitHub host', () => {
    expect(bash('gh pr create --fill')).toBe(REASONS.remote);
    expect(bash('hub browse')).toBe(REASONS.remote);
    expect(bash('curl -s https://api.github.com/repos/o/n')).toBe(REASONS.github);
    expect(bash('wget https://raw.githubusercontent.com/o/n/main/x')).toBe(REASONS.github);
  });

  it('allows local Git work', () => {
    for (const command of [
      'git status',
      'git add -A && git commit -m "Add notes"',
      'git log --oneline -5',
      'git diff HEAD~1',
      'git remote -v',
      'git branch --show-current',
    ]) {
      expect(bash(command), command).toBeNull();
    }
  });

  it('refuses the daemon folder and the Claude configuration folders', () => {
    expect(bash('cat ~/.orchestrator/config.json')).toBe(REASONS.home);
    expect(bash(`cat ${daemonHome}/config.json`)).toBe(REASONS.daemonFolder);
    expect(bash(`ls ${daemonHome}/worktrees/run-2`)).toBe(REASONS.daemonFolder);
    expect(bash(`cat ${daemonHome}/claude-config/.credentials.json`)).toBe(REASONS.claudeConfig);
    expect(bash('cat ~/.claude/settings.json')).toBe(REASONS.claudeConfig);
    expect(bash('cat $HOME/.claude.json')).toBe(REASONS.claudeConfig);
    expect(bash('cat ../../config.json')).toBe(REASONS.daemonFolder);
  });

  it("refuses the browsers and Playwright folders and the variable naming the first, but lets Playwright's commands through", () => {
    expect(bash(`ls ${daemonHome}/browsers`)).toBe(REASONS.browsers);
    // The daemon's own install, owner of the browsers: removing it lets Playwright remove them.
    expect(bash(`rm -rf ${daemonHome}/playwright`)).toBe(REASONS.browsers);
    expect(bash(`${daemonHome}/playwright/node_modules/.bin/playwright uninstall --all`)).toBe(
      REASONS.browsers,
    );
    expect(bash(`rm -rf ${daemonHome}/browsers/chromium_headless_shell-1248`)).toBe(
      REASONS.browsers,
    );
    expect(bash('ls $PLAYWRIGHT_BROWSERS_PATH')).toBe(REASONS.browsers);
    expect(bash('rm -rf "${PLAYWRIGHT_BROWSERS_PATH}"/*')).toBe(REASONS.browsers);
    expect(bash('PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium')).toBe(
      REASONS.browsers,
    );
    expect(bash('unset PLAYWRIGHT_BROWSERS_PATH; npx playwright test')).toBe(REASONS.browsers);
    expect(bash('npx playwright install chromium')).toBeNull();
    expect(bash('npx playwright test --project=chromium')).toBeNull();
  });

  it("refuses commands naming the repository's .claude folder, even to read it", () => {
    expect(bash('echo x > .claude/settings.json')).toBe(REASONS.claudeFolder);
    expect(bash('cat .claude/settings.json')).toBe(REASONS.claudeFolder);
    expect(bash('rm -rf ./.claude')).toBe(REASONS.claudeFolder);
  });

  it('refuses the container tools, in any form', () => {
    for (const command of [
      'docker ps',
      'docker',
      'docker inspect orchestrator',
      'docker compose up -d',
      'docker-compose ps',
      '/usr/bin/docker ps',
      'sudo docker ps',
      'env DOCKER_HOST=x docker ps',
      'npm test && docker ps',
      'echo $(docker ps -q)',
      'podman ps',
      'nerdctl inspect orchestrator',
      'kubectl get pods',
      'sudo /usr/bin/podman ps',
    ]) {
      expect(bash(command), command).toBe(REASONS.containers);
    }
    for (const command of [
      'cat Dockerfile',
      'ls docker',
      'cat docker/compose.yml',
      'grep docker README.md',
    ]) {
      expect(bash(command), command).toBeNull();
    }
  });

  it('refuses any command naming tmux', () => {
    expect(bash('tmux ls')).toBe(REASONS.tmux);
    expect(bash('/usr/bin/tmux -L orchestrator send-keys x')).toBe(REASONS.tmux);
    expect(bash('npm test; tmux kill-server')).toBe(REASONS.tmux);
    expect(bash('grep tmux README.md')).toBe(REASONS.tmux);
    expect(bash('echo tmuxinator')).toBeNull();
  });

  it('refuses the home folder and paths outside the worktree, best effort', () => {
    expect(bash('ls ~')).toBe(REASONS.home);
    expect(bash('cat ${HOME}/notes.txt')).toBe(REASONS.home);
    expect(bash(`cat ${userHome}/.ssh/id_ed25519`)).toBe(REASONS.bashPath);
    expect(bash('cat /mnt/c/Users/owner/Documents/x.txt')).toBe(REASONS.bashPath);
    expect(bash('cat /var/log/syslog')).toBe(REASONS.bashPath);
    expect(bash('ls /root')).toBe(REASONS.bashPath);
    expect(bash('cat ../../../other')).toBe(REASONS.bashPath);
    expect(bash('cp notes.md --target-directory=/srv/x')).toBe(REASONS.bashPath);
    expect(bash('npm test > /home/other/out.txt')).toBe(REASONS.bashPath);
  });

  it('does not take text whose first folder is not at the root for a path, such as a route', () => {
    for (const command of [
      'grep -rn "/api/users" src',
      'curl -s localhost:3000/api/notes/12',
      'grep -r /users/:id/settings src',
      'echo /v1/health',
    ]) {
      expect(bash(command), command).toBeNull();
    }
  });

  it('still checks a path that does not exist yet under an existing root folder', () => {
    expect(bash('echo secret > /home/other/new-file.txt')).toBe(REASONS.bashPath);
    expect(bash('touch /mnt/c/Users/owner/new.txt')).toBe(REASONS.bashPath);
    expect(bash('mkdir -p /var/new-folder/deeper')).toBe(REASONS.bashPath);
    expect(bash(`cp notes.md ${userHome}/not-yet/copy.md`)).toBe(REASONS.bashPath);
    // `..` is resolved first: text starting with an unknown folder cannot hide a real path.
    expect(bash('cat /api/../home/other/.ssh/id_ed25519')).toBe(REASONS.bashPath);
    // The root itself is a path.
    expect(bash('ls /')).toBe(REASONS.bashPath);
  });

  it('looks at the real filesystem root by default', () => {
    const real: PermissionScope = { worktree, daemonHome, userHome, tempDirs: ['/tmp'] };
    expect(checkBash(real, 'grep -rn "/no-such-root-folder-od/users" src')).toBeNull();
    expect(checkBash(real, 'touch /usr/../no-such-root-folder-od-2')).toBeNull();
    expect(checkBash(real, 'cat /proc/1/environ')).toBe(REASONS.bashPath);
  });

  it('allows the worktree, the standard devices, the temporary folder and system folders', () => {
    for (const command of [
      'pnpm test',
      'npm run build > /dev/null 2>&1',
      'cat src/index.ts | head -20',
      `cat ${worktree}/src/index.ts`,
      'ls ./src/../src',
      'mktemp -d /tmp/build.XXXX && ls /tmp',
      '/usr/bin/env node --version',
      'cat /etc/os-release',
      'ls /opt /lib/x86_64-linux-gnu /lib64 /bin/sh /sbin',
      'cat /proc/self/status',
      'curl -s http://localhost:3000/api/notes',
      'echo "a b" \'c d\'',
    ]) {
      expect(bash(command), command).toBeNull();
    }
  });
});

describe('PreToolUse rules for file tools', () => {
  it('allows the worktree, with relative and absolute paths', () => {
    expect(tool('Read', { file_path: join(worktree, 'src', 'index.ts') })).toBeNull();
    expect(tool('Write', { file_path: 'src/new.ts', content: 'x' })).toBeNull();
    expect(tool('Edit', { file_path: join(worktree, 'README.md') })).toBeNull();
    expect(tool('Glob', { pattern: 'src/**/*.ts' })).toBeNull();
    expect(tool('Grep', { pattern: 'TODO', path: 'src' })).toBeNull();
    expect(tool('Read', { file_path: join(worktree, '.claude', 'settings.json') })).toBeNull();
  });

  it('refuses the Claude configuration folders and the daemon folder, exactly', () => {
    expect(tool('Read', { file_path: join(userHome, '.claude', 'settings.json') })).toBe(
      REASONS.claudeConfig,
    );
    expect(tool('Read', { file_path: join(userHome, '.claude.json') })).toBe(REASONS.claudeConfig);
    expect(tool('Read', { file_path: join(daemonHome, 'claude-config', '.claude.json') })).toBe(
      REASONS.claudeConfig,
    );
    expect(tool('Read', { file_path: join(daemonHome, 'config.json') })).toBe(REASONS.daemonFolder);
    expect(tool('Read', { file_path: '../run-2/src/x.ts' })).toBe(REASONS.daemonFolder);
    expect(tool('Glob', { pattern: join(daemonHome, 'browsers', '**') })).toBe(REASONS.browsers);
    expect(tool('Write', { file_path: '../../browsers/x' })).toBe(REASONS.browsers);
    expect(tool('Edit', { file_path: join(daemonHome, 'playwright', 'package.json') })).toBe(
      REASONS.browsers,
    );
    // Through a symbolic link in the worktree.
    expect(tool('Read', { file_path: 'src/key.json' })).toBe(REASONS.daemonFolder);
  });

  it('refuses any other path outside the worktree, even in the temporary folder', () => {
    expect(tool('Read', { file_path: '/etc/passwd' })).toBe(REASONS.outside);
    expect(tool('Write', { file_path: '/tmp/x.txt' })).toBe(REASONS.outside);
    expect(tool('Glob', { pattern: '/home/**/*.pem' })).toBe(REASONS.outside);
    expect(tool('Grep', { pattern: 'x', path: '/' })).toBe(REASONS.outside);
    expect(tool('LS', { path: '~' })).toBe(REASONS.outside);
  });

  it("refuses changes to the repository's .claude folder", () => {
    expect(tool('Write', { file_path: '.claude/settings.json' })).toBe(REASONS.claudeFolder);
    expect(tool('Edit', { file_path: join(worktree, '.claude', 'settings.json') })).toBe(
      REASONS.claudeFolder,
    );
    expect(tool('NotebookEdit', { notebook_path: '.claude/x.ipynb' })).toBe(REASONS.claudeFolder);
  });

  it('lets other tools through: the allowlist decides, and WebFetch may read GitHub', () => {
    expect(tool('WebFetch', { url: 'https://github.com/o/n' })).toBeNull();
    expect(tool('mcp__orchestrator__ticket_get', {})).toBeNull();
    expect(tool('ToolSearch', { query: 'x' })).toBeNull();
    expect(checkToolCall(scope, 'Bash', 'not an object')).toBeNull();
  });
});

describe('the end of every refusal reason (lot 3 step L, decision Q29)', () => {
  // The words of the common rules, written out: a change to the constant must fail here.
  const SUFFIX =
    'Do not ask the owner to allow it. If your ticket cannot be done without it, say so in plain words with ticket_ask or ticket_give_up.';

  /** One call refused for each reason, as the hook checks it. */
  const refused: Record<keyof typeof REASONS, () => string | null> = {
    remote: () => bash('git push origin HEAD'),
    github: () => bash('curl -s https://api.github.com/repos/o/n'),
    containers: () => bash('docker ps'),
    tmux: () => bash('tmux ls'),
    claudeFolder: () => tool('Write', { file_path: '.claude/settings.json' }),
    daemonFolder: () => tool('Read', { file_path: join(daemonHome, 'config.json') }),
    claudeConfig: () => tool('Read', { file_path: join(userHome, '.claude.json') }),
    browsers: () => bash('ls $PLAYWRIGHT_BROWSERS_PATH'),
    outside: () => tool('Read', { file_path: '/etc/passwd' }),
    bashPath: () => bash('cat /var/log/syslog'),
    home: () => bash('ls ~'),
  };

  it('is the same sentence for every reason', () => {
    expect(REFUSAL_SUFFIX).toBe(SUFFIX);
  });

  for (const [key, call] of Object.entries(refused)) {
    it(`ends the ${key} refusal with it, once`, () => {
      const reason = call();
      expect(reason).toBe(REASONS[key as keyof typeof REASONS]);
      expect(reason?.endsWith(` ${SUFFIX}`)).toBe(true);
      expect(reason?.split(SUFFIX)).toHaveLength(2);
      // The old ending of lot 2, which contradicted the common rules, is gone.
      expect(reason).not.toContain('explain why with ticket_ask');
    });
  }
});

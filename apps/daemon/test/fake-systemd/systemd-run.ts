import { spawn } from 'node:child_process';
import { constants } from 'node:os';

// A fake `systemd-run --user --scope … --unit <unit> -- <command>` (lot 5 step 5bis D): runs the
// command where a scope would hold it, after expanding its arguments as systemd 254 and later do
// by default (systemd.service(5), "Command lines"), unless `--expand-environment=no`: `$$` is a
// `$`, `${NAME}` within a word is the variable's value, empty when unset or not a valid name,
// and a word that is only `$NAME` is the value split on white space. `FAKE_SYSTEMD_VERSION`
// (default 259) is what `--version` says; before 254 the option is refused and nothing expanded.

const version = Number(process.env.FAKE_SYSTEMD_VERSION ?? '259');
const args = process.argv.slice(2);
if (args[0] === '--version') {
  process.stdout.write(`systemd ${String(version)} (${String(version)}-fake)\n+PAM +SELINUX\n`);
  process.exit(0);
}

let expand = version >= 254;
let index = 0;
for (; index < args.length; index += 1) {
  const arg = args[index] ?? '';
  if (arg === '--') break;
  if (arg === '--unit') {
    index += 1;
    continue;
  }
  const option = /^--expand-environment=(.*)$/.exec(arg);
  if (option && version >= 254) {
    expand = !['no', 'false', '0', 'off'].includes(option[1] ?? '');
    continue;
  }
  if (['--user', '--scope', '--quiet', '--collect'].includes(arg)) continue;
  if (arg.startsWith('--property=')) continue;
  process.stderr.write(`systemd-run: unrecognized option '${arg}'\n`);
  process.exit(1);
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
function expanded(word: string): string[] {
  const whole = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(word);
  if (whole) return (process.env[whole[1] ?? ''] ?? '').split(/\s+/).filter(Boolean);
  return [
    word.replace(/\$\$|\$\{([^}]*)\}/g, (match, name: string | undefined) => {
      if (match === '$$') return '$';
      if (!NAME.test(name ?? '')) {
        process.stderr.write(
          `Invalid environment variable name evaluates to an empty string: ${name ?? ''}\n`,
        );
        return '';
      }
      return process.env[name ?? ''] ?? '';
    }),
  ];
}

const [file = '', ...rest] = args
  .slice(index + 1)
  .flatMap((word) => (expand ? expanded(word) : [word]));
const child = spawn(file, rest, { stdio: 'inherit' });
for (const signal of ['SIGHUP', 'SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => child.kill(signal));
}
child.on('error', (error) => {
  process.stderr.write(`systemd-run: ${error.message}\n`);
  process.exit(1);
});
child.on('exit', (code, signal) =>
  process.exit(code ?? 128 + (signal ? constants.signals[signal] : 0)),
);

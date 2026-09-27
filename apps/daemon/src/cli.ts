import { text } from 'node:stream/consumers';
import { parseArgs } from 'node:util';
import { HookEvent, RunId } from '@orchestrator/protocol';
import { attach } from './attach.js';
import { safeJson } from './config.js';
import { gitCredentialHelper } from './credentials.js';
import { runDoctor } from './doctor.js';
import { enroll } from './enroll.js';
import { doctorEnvironment } from './environment.js';
import { UserError } from './errors.js';
import { installService } from './install-service.js';
import { describeLastStop, readLastStop } from './last-stop.js';
import { login } from './login.js';
import { runRelay } from './mcp-relay.js';
import { daemonPaths } from './paths.js';
import { forwardToRun } from './run-socket.js';
import { startDaemon } from './start.js';
import { formatChecks, status } from './status.js';
import { DAEMON_VERSION } from './version.js';

// The `orchestrator-daemon` command (05, section 8).

const USAGE = `orchestrator-daemon ${DAEMON_VERSION}: runs the Orchestrator's agents on this machine.

Commands:
  enroll <url> <code> [--ca-file <path>]   Connect this machine to the Orchestrator (once)
  login                                    Log in to Claude Code for the Orchestrator (once)
  install-service                          Run the daemon as a background service
  start                                    Run the daemon in this terminal
  status                                   Show whether the daemon runs and is connected
  doctor                                   Check this machine
  attach <run-id> [--write]                Watch a run's session live (read-only by default)
  --version                                Show the version

Help: the Machines page of the Orchestrator's Help.`;

const out = (line: string) => {
  process.stdout.write(`${line}\n`);
};

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const paths = daemonPaths();
  const parse = <Options extends Record<string, { type: 'string' | 'boolean' }>>(
    options: Options,
    positionals: number,
  ) => {
    const parsed = parseArgs({ args: rest, options, allowPositionals: true, strict: true });
    if (parsed.positionals.length !== positionals) {
      throw new UserError(`Wrong number of arguments.\n\n${USAGE}`);
    }
    return parsed;
  };

  switch (command) {
    case '--version':
    case '-v':
    case 'version':
      out(DAEMON_VERSION);
      return 0;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      out(USAGE);
      return 0;
    case 'enroll': {
      const { positionals, values } = parse({ 'ca-file': { type: 'string' } }, 2);
      const [url = '', code = ''] = positionals;
      await enroll(paths, { url, code, caFile: values['ca-file'] }, out);
      return 0;
    }
    case 'login':
      parse({}, 0);
      return login(paths, out);
    case 'start': {
      const { values } = parse({ service: { type: 'boolean' } }, 0);
      return startDaemon({ paths, mode: values.service ? 'service' : 'terminal' });
    }
    case 'status':
      parse({}, 0);
      return status(paths, out);
    case 'doctor': {
      parse({}, 0);
      const result = await runDoctor(doctorEnvironment(paths, 'command'));
      out(`Checks of this machine (orchestrator-daemon ${DAEMON_VERSION}):`);
      for (const line of formatChecks(result.checks)) out(line);
      const stop = await readLastStop(paths.lastStop);
      if (stop) out(describeLastStop(stop));
      const errors = result.checks.filter((check) => check.status === 'error').length;
      out(
        errors === 0
          ? 'No error.'
          : `${String(errors)} error(s): the machine gets no runs until they are fixed. Then restart the daemon (systemctl --user restart orchestrator-daemon).`,
      );
      return errors === 0 ? 0 : 1;
    }
    case 'install-service':
      parse({}, 0);
      await installService(paths, process.argv[1] ?? '', out);
      return 0;
    case 'attach': {
      const { positionals, values } = parse({ write: { type: 'boolean' } }, 1);
      return attach(positionals[0] ?? '', values.write ?? false, { input: process.stdin, out });
    }
    // Internal commands run by Claude Code and Git (05, sections 4.5, 7 and 8).
    case 'hook':
    case 'status-line': {
      const { positionals, values } = parse(
        { run: { type: 'string' } },
        command === 'hook' ? 1 : 0,
      );
      const runId = RunId.safeParse(values.run);
      const event = HookEvent.safeParse(positionals[0]);
      if (!runId.success || (command === 'hook' && !event.success)) {
        throw new UserError(
          `Usage: orchestrator-daemon ${command}${command === 'hook' ? ' <event>' : ''} --run <run-id>`,
        );
      }
      const input = safeJson(await text(process.stdin));
      const answer = await forwardToRun(
        paths,
        runId.data,
        command === 'hook' && event.success
          ? { type: 'hook', event: event.data, input }
          : { type: 'status_line', input },
      );
      process.stdout.write(answer.stdout);
      return answer.exitCode;
    }
    case 'mcp': {
      const { values } = parse({ run: { type: 'string' } }, 0);
      const runId = RunId.safeParse(values.run);
      if (!runId.success) throw new UserError('Usage: orchestrator-daemon mcp --run <run-id>');
      return runRelay(paths, runId.data);
    }
    case 'git-credential': {
      const { positionals } = parse({}, 1);
      const input = await text(process.stdin);
      process.stdout.write(await gitCredentialHelper(positionals[0] ?? '', input, process.env));
      return 0;
    }
    default:
      throw new UserError(`Unknown command "${command}".\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof UserError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = error.exitCode;
      return;
    }
    // parseArgs refusals (unknown option) are the owner's typing, not a bug.
    if (
      error instanceof TypeError &&
      'code' in error &&
      String(error.code).startsWith('ERR_PARSE_ARGS')
    ) {
      process.stderr.write(`${error.message}\n\n${USAGE}\n`);
      process.exitCode = 1;
      return;
    }
    process.stderr.write(
      `Unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  },
);

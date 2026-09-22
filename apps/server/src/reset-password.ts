import { createInterface } from 'node:readline';
import { schema } from '@orchestrator/db';
import { NewPassword } from '@orchestrator/protocol';
import { eq } from 'drizzle-orm';
import { hashPassword } from './auth/password.js';
import { revokeAllSessions } from './auth/sessions.js';
import type { Database } from './database.js';
import { recordEvent } from './events.js';

/** A refusal explained to the person running the command. */
export class ResetPasswordError extends Error {
  override name = 'ResetPasswordError';
}

/**
 * Sets a new owner password, revokes every session and writes an event (09, section 7.4).
 * Applies the same rules as the setup wizard.
 */
export async function resetPassword(db: Database, password: string): Promise<{ username: string }> {
  const rules = NewPassword.safeParse(password);
  if (!rules.success) {
    throw new ResetPasswordError(
      `The password must have ${rules.error.issues[0]?.message ?? 'a valid length'}.`,
    );
  }
  const passwordHash = await hashPassword(password);
  return db.transaction(async (tx) => {
    const [owner] = await tx
      .update(schema.owner)
      .set({ passwordHash })
      .where(eq(schema.owner.id, 1))
      .returning({ username: schema.owner.username });
    if (!owner) {
      throw new ResetPasswordError(
        'There is no owner account yet: create it in the setup wizard of the web interface.',
      );
    }
    const revokedSessions = await revokeAllSessions(tx);
    await recordEvent(tx, {
      actor: 'cli',
      entityType: 'owner',
      entityId: '1',
      type: 'owner.password_reset',
      payload: { revokedSessions },
    });
    return owner;
  });
}

interface Terminal {
  input: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };
  output: NodeJS.WritableStream;
}

/**
 * Asks for the new password twice. On a terminal the typing is not shown; otherwise (a pipe,
 * used by tests and scripts) each answer is one line. Never taken as an argument, so it does not
 * stay in the shell history.
 */
export async function askNewPassword({ input, output }: Terminal): Promise<string> {
  const ask = input.isTTY && input.setRawMode ? askHidden : lineReader(input, output);
  const first = await ask('New password (at least 12 characters): ', { input, output });
  const second = await ask('Type it again: ', { input, output });
  if (first !== second) throw new ResetPasswordError('The two passwords are different.');
  return first;
}

type Ask = (prompt: string, terminal: Terminal) => Promise<string>;

function lineReader(input: Terminal['input'], output: Terminal['output']): Ask {
  const lines = createInterface({ input, terminal: false })[Symbol.asyncIterator]();
  return async (prompt) => {
    output.write(prompt);
    const line = await lines.next();
    if (line.done) throw new ResetPasswordError('No password given.');
    output.write('\n');
    return line.value;
  };
}

function askHidden(prompt: string, { input, output }: Terminal): Promise<string> {
  output.write(prompt);
  input.setRawMode?.(true);
  input.setEncoding('utf8');
  input.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error?: Error) => {
      input.off('data', onData);
      input.setRawMode?.(false);
      input.pause();
      output.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string | Buffer) => {
      for (const char of String(chunk)) {
        if (char === '\r' || char === '\n') {
          finish();
          return;
        }
        if (char === '\u0003' || char === '\u0004') {
          finish(new ResetPasswordError('Cancelled.'));
          return;
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    input.on('data', onData);
  });
}

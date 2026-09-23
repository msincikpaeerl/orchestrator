import { schema } from '@orchestrator/db';
import type { SettingValues } from '@orchestrator/protocol';
import { eq, inArray, lt } from 'drizzle-orm';
import type { Database } from '../database.js';
import { recordEvent } from '../events.js';
import { resolveSettings } from '../settings/store.js';

// Login throttling (ADR 0015): after `loginFailuresBeforeDelay` failures for a username or a
// client address, the next attempt must wait a delay that doubles with each further failure,
// up to `loginMaxDelaySeconds`. During the delay the password is not even checked.

export interface LoginAttempt {
  username: string;
  address: string;
}

const THROTTLE_SETTINGS = [
  'loginFailuresBeforeDelay',
  'loginFirstDelaySeconds',
  'loginMaxDelaySeconds',
  'loginFailureMemoryMinutes',
] as const;
type ThrottleSettings = Pick<SettingValues, (typeof THROTTLE_SETTINGS)[number]>;

function keys({ username, address }: LoginAttempt) {
  return [
    { key: `username:${username.trim().toLowerCase()}`, scope: 'username' as const },
    { key: `address:${address}`, scope: 'address' as const },
  ];
}

/** Delay after `failures` consecutive failures, in seconds; 0 below the limit. */
export function delayAfter(failures: number, settings: ThrottleSettings): number {
  const over = failures - settings.loginFailuresBeforeDelay;
  if (over < 0) return 0;
  return Math.min(settings.loginMaxDelaySeconds, settings.loginFirstDelaySeconds * 2 ** over);
}

export class LoginThrottle {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Read at each attempt: a changed setting applies to the next login without a restart. */
  private settings(): Promise<ThrottleSettings> {
    return resolveSettings(this.db, THROTTLE_SETTINGS);
  }

  private forgottenBefore(settings: ThrottleSettings): Date {
    return new Date(this.now().getTime() - settings.loginFailureMemoryMinutes * 60_000);
  }

  /** Seconds to wait before this attempt may be checked; 0 when it may be checked now. */
  async waitSeconds(attempt: LoginAttempt): Promise<number> {
    const forgottenBefore = this.forgottenBefore(await this.settings());
    const rows = await this.db
      .select()
      .from(schema.loginFailures)
      .where(
        inArray(
          schema.loginFailures.key,
          keys(attempt).map((entry) => entry.key),
        ),
      );
    const now = this.now().getTime();
    let wait = 0;
    for (const row of rows) {
      if (row.lastFailureAt < forgottenBefore || !row.blockedUntil) continue;
      wait = Math.max(wait, Math.ceil((row.blockedUntil.getTime() - now) / 1000));
    }
    return wait;
  }

  /** Counts a failure for the username and the address; writes an event when a delay starts. */
  async recordFailure(attempt: LoginAttempt): Promise<void> {
    const settings = await this.settings();
    const now = this.now();
    const forgottenBefore = this.forgottenBefore(settings);
    await this.db.transaction(async (tx) => {
      await tx
        .delete(schema.loginFailures)
        .where(lt(schema.loginFailures.lastFailureAt, forgottenBefore));
      for (const { key, scope } of keys(attempt)) {
        const [previous] = await tx
          .select()
          .from(schema.loginFailures)
          .where(eq(schema.loginFailures.key, key))
          .for('update');
        const failures = (previous?.failures ?? 0) + 1;
        const delaySeconds = delayAfter(failures, settings);
        const blockedUntil =
          delaySeconds > 0 ? new Date(now.getTime() + delaySeconds * 1000) : null;
        const values = { failures, lastFailureAt: now, blockedUntil };
        await tx
          .insert(schema.loginFailures)
          .values({ key, ...values })
          .onConflictDoUpdate({ target: schema.loginFailures.key, set: values });
        if (delaySeconds > 0) {
          // The typed username is not recorded: it may be a password typed in the wrong field.
          await recordEvent(tx, {
            actor: 'system',
            entityType: 'owner',
            entityId: '1',
            type: 'owner.login_throttled',
            payload: {
              scope,
              ...(scope === 'address' ? { address: attempt.address } : {}),
              failures,
              delaySeconds,
            },
          });
        }
      }
    });
  }

  /** A successful login forgets the failures of its username and address. */
  async clear(attempt: LoginAttempt): Promise<void> {
    await this.db.delete(schema.loginFailures).where(
      inArray(
        schema.loginFailures.key,
        keys(attempt).map((entry) => entry.key),
      ),
    );
  }
}

/** Used by `orchestrator reset-password`: the owner may log in at once with the new password. */
export async function clearAllLoginFailures(db: Pick<Database, 'delete'>): Promise<void> {
  await db.delete(schema.loginFailures);
}

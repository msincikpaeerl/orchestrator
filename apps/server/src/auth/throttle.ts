import { schema } from '@orchestrator/db';
import type { SettingValues } from '@orchestrator/protocol';
import { eq, inArray, lt } from 'drizzle-orm';
import type { Database } from '../database.js';
import { recordEvent, type NewEvent } from '../events.js';
import { resolveSettings } from '../settings/store.js';

// Login throttling (ADR 0015): after `loginFailuresBeforeDelay` failures for a username or a
// client address, the next attempt must wait a delay that doubles with each further failure,
// up to `loginMaxDelaySeconds`. During the delay the password is not even checked. Failed
// enrollment codes are throttled the same way, per client address under their own key, so a
// daemon retrying a bad code never delays the owner's login (05, section 3.1).

export interface LoginAttempt {
  username: string;
  address: string;
}

/** One counter of failures, and the event written when its delay starts. */
export interface ThrottleKey {
  key: string;
  event: (failures: number, delaySeconds: number) => NewEvent;
}

const THROTTLE_SETTINGS = [
  'loginFailuresBeforeDelay',
  'loginFirstDelaySeconds',
  'loginMaxDelaySeconds',
  'loginFailureMemoryMinutes',
] as const;
type ThrottleSettings = Pick<SettingValues, (typeof THROTTLE_SETTINGS)[number]>;

/** The counters of a login: its username and its address. */
export function loginKeys({ username, address }: LoginAttempt): ThrottleKey[] {
  const event =
    (scope: 'username' | 'address') =>
    (failures: number, delaySeconds: number): NewEvent => ({
      actor: 'system',
      entityType: 'owner',
      entityId: '1',
      type: 'owner.login_throttled',
      // The typed username is not recorded: it may be a password typed in the wrong field.
      payload: { scope, ...(scope === 'address' ? { address } : {}), failures, delaySeconds },
    });
  return [
    { key: `username:${username.trim().toLowerCase()}`, event: event('username') },
    { key: `address:${address}`, event: event('address') },
  ];
}

/** The counter of enrollment attempts from one client address. */
export function enrollmentKeys(address: string): ThrottleKey[] {
  return [
    {
      key: `enrollment:${address}`,
      event: (failures, delaySeconds) => ({
        actor: 'system',
        entityType: 'machine',
        type: 'machine.enrollment_throttled',
        payload: { address, failures, delaySeconds },
      }),
    },
  ];
}

/** Delay after `failures` consecutive failures, in seconds; 0 below the limit. */
export function delayAfter(failures: number, settings: ThrottleSettings): number {
  const over = failures - settings.loginFailuresBeforeDelay;
  if (over < 0) return 0;
  return Math.min(settings.loginMaxDelaySeconds, settings.loginFirstDelaySeconds * 2 ** over);
}

/** Counts failures per key and says how long the next attempt must wait. */
export class Throttle {
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
  async waitSeconds(keys: ThrottleKey[]): Promise<number> {
    const forgottenBefore = this.forgottenBefore(await this.settings());
    const rows = await this.db
      .select()
      .from(schema.loginFailures)
      .where(
        inArray(
          schema.loginFailures.key,
          keys.map((entry) => entry.key),
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

  /** Counts a failure for each key; writes the key's event when its delay starts. */
  async recordFailure(keys: ThrottleKey[]): Promise<void> {
    const settings = await this.settings();
    const now = this.now();
    const forgottenBefore = this.forgottenBefore(settings);
    await this.db.transaction(async (tx) => {
      await tx
        .delete(schema.loginFailures)
        .where(lt(schema.loginFailures.lastFailureAt, forgottenBefore));
      for (const { key, event } of keys) {
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
        if (delaySeconds > 0) await recordEvent(tx, event(failures, delaySeconds));
      }
    });
  }

  /** A success forgets the failures of its keys. */
  async clear(keys: ThrottleKey[]): Promise<void> {
    await this.db.delete(schema.loginFailures).where(
      inArray(
        schema.loginFailures.key,
        keys.map((entry) => entry.key),
      ),
    );
  }
}

/** Used by `orchestrator reset-password`: the owner may log in at once with the new password. */
export async function clearAllLoginFailures(db: Pick<Database, 'delete'>): Promise<void> {
  await db.delete(schema.loginFailures);
}

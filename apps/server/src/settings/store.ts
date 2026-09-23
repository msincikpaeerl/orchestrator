import { schema } from '@orchestrator/db';
import { SETTING_ORDER, SETTINGS, SettingName, type SettingValues } from '@orchestrator/protocol';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Database, Executor } from '../database.js';
import { recordEvent } from '../events.js';
import { HttpError } from '../http.js';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Values of settings (04, section 8), read when they are needed so a change applies to the next
 * action without a restart. The only way code reads a setting: for each name, the project's
 * override, then the global value, then the default of `SETTINGS`.
 */
export async function resolveSettings<const Names extends readonly SettingName[]>(
  db: Pick<Executor, 'select'>,
  names: Names,
  projectId?: string,
): Promise<Pick<SettingValues, Names[number]>> {
  const rows = await db
    .select()
    .from(schema.settingValues)
    .where(
      and(
        inArray(schema.settingValues.name, [...names]),
        projectId === undefined
          ? isNull(schema.settingValues.projectId)
          : or(
              isNull(schema.settingValues.projectId),
              eq(schema.settingValues.projectId, projectId),
            ),
      ),
    );
  const values: Partial<SettingValues> = {};
  for (const name of names) {
    const global = rows.find((row) => row.name === name && row.projectId === null);
    const override = rows.find((row) => row.name === name && row.projectId !== null);
    values[name] = (override ?? global)?.value ?? SETTINGS[name].default;
  }
  return values as Pick<SettingValues, Names[number]>;
}

/** Values stored for one scope: the global values, or one project's overrides. */
export async function storedValues(
  db: Pick<Executor, 'select'>,
  projectId: string | null,
): Promise<Map<SettingName, number>> {
  const rows = await db
    .select()
    .from(schema.settingValues)
    .where(
      projectId === null
        ? isNull(schema.settingValues.projectId)
        : eq(schema.settingValues.projectId, projectId),
    );
  const values = new Map<SettingName, number>();
  for (const row of rows) {
    // A row of a setting removed from `SETTINGS` in a later version is ignored.
    const name = SettingName.safeParse(row.name);
    if (name.success) values.set(name.data, row.value);
  }
  return values;
}

function scope(projectId: string | null) {
  return projectId === null
    ? isNull(schema.settingValues.projectId)
    : eq(schema.settingValues.projectId, projectId);
}

/** Who a change is about, for its event: the global value or one project's override. */
export type SettingScope = { projectId: null } | { projectId: string; projectKey: string };

async function current(tx: Executor, name: SettingName, projectId: string | null) {
  const [row] = await tx
    .select()
    .from(schema.settingValues)
    .where(and(eq(schema.settingValues.name, name), scope(projectId)))
    .for('update');
  return row ?? null;
}

function eventPayload(name: SettingName, target: SettingScope) {
  return {
    name,
    ...(target.projectId === null
      ? { scope: 'global' }
      : { scope: 'project', projectId: target.projectId, projectKey: target.projectKey }),
  };
}

/**
 * Stores a value (already checked against its range) and writes `setting.changed`. `previous` is
 * null when the default (or, for a project, the global value) was used. Nothing is written when
 * the value does not change.
 */
async function storeSetting(
  tx: Executor,
  name: SettingName,
  target: SettingScope,
  value: number,
): Promise<void> {
  const previous = await current(tx, name, target.projectId);
  if (previous?.value === value) return;
  const now = new Date();
  if (previous) {
    await tx
      .update(schema.settingValues)
      .set({ value, updatedAt: now })
      .where(and(eq(schema.settingValues.name, name), scope(target.projectId)));
  } else {
    // Two first saves at the same moment: the later one wins, as with an update.
    await tx
      .insert(schema.settingValues)
      .values({ name, projectId: target.projectId, value, updatedAt: now })
      .onConflictDoUpdate({
        target: [schema.settingValues.name, schema.settingValues.projectId],
        set: { value, updatedAt: now },
      });
  }
  await recordEvent(tx, {
    actor: 'owner',
    entityType: 'setting',
    entityId: name,
    type: 'setting.changed',
    payload: { ...eventPayload(name, target), previous: previous?.value ?? null, value },
  });
}

/**
 * **Reset to default**: deletes the stored value and writes `setting.reset`. For a project, the
 * global value applies again. Nothing is written when no value was stored.
 */
async function resetSetting(tx: Executor, name: SettingName, target: SettingScope): Promise<void> {
  const previous = await current(tx, name, target.projectId);
  if (!previous) return;
  await tx
    .delete(schema.settingValues)
    .where(and(eq(schema.settingValues.name, name), scope(target.projectId)));
  await recordEvent(tx, {
    actor: 'owner',
    entityType: 'setting',
    entityId: name,
    type: 'setting.reset',
    payload: { ...eventPayload(name, target), previous: previous.value },
  });
}

/**
 * After a change or reset of `name`, in its transaction: refuses it (rolling it back with its
 * event) when a pair of `SETTING_ORDER` is no longer in order (04, section 8; 07, section 8).
 */
async function checkOrder(tx: Executor, name: SettingName, projectId: string | null) {
  for (const { smaller, larger } of SETTING_ORDER) {
    if (name !== smaller && name !== larger) continue;
    const values = await resolveSettings(tx, [smaller, larger], projectId ?? undefined);
    if (values[smaller] <= values[larger]) continue;
    throw new HttpError(
      409,
      'setting_order_invalid',
      `${smaller} (${String(values[smaller])}) cannot be above ${larger} (${String(values[larger])})`,
      {
        settingOrder: {
          smaller,
          larger,
          smallerValue: values[smaller],
          largerValue: values[larger],
        },
      },
    );
  }
}

/**
 * The only way to change a setting: stores `value` (already checked against its range), or
 * deletes the stored value for **Reset to default** when `value` is null, then checks the order
 * of related settings. Changes run one at a time (a table lock that does not block reads), so two
 * changes each valid alone cannot together break an order.
 */
export async function changeSetting(
  tx: Transaction,
  name: SettingName,
  target: SettingScope,
  value: number | null,
): Promise<void> {
  await tx.execute(sql`LOCK TABLE setting_values IN SHARE ROW EXCLUSIVE MODE`);
  if (value === null) await resetSetting(tx, name, target);
  else await storeSetting(tx, name, target, value);
  await checkOrder(tx, name, target.projectId);
}

import type { AccountPlan } from '@orchestrator/protocol';

/** Claude plans in plain words (01, section 3.9). */
export const planLabel: Record<AccountPlan, string> = {
  pro: 'Pro',
  max_5x: 'Max 5x',
  max_20x: 'Max 20x',
};

/** `1 run at a time`, `3 runs at a time`. */
export function concurrentRuns(count: number): string {
  return `${String(count)} run${count === 1 ? '' : 's'} at a time`;
}

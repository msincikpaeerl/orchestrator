import { z } from 'zod';

/** Sections of Settings > Limits, in display order. */
export const SettingGroup = z.enum([
  'sessions',
  'github',
  'tickets',
  'runs',
  'machines',
  'scheduler',
]);
export type SettingGroup = z.infer<typeof SettingGroup>;

/**
 * One setting (04, section 8): every limit and timeout is a whole number with a default, changed
 * from Settings > Limits, and for some also per project.
 */
export interface SettingDefinition {
  group: SettingGroup;
  /** Name shown on screen and in the user documentation's settings reference. */
  label: string;
  /** What it does, in plain words. */
  description: string;
  /** Unit of the value, plural (`days`, `characters`, `tickets`). */
  unit: string;
  min: number;
  max: number;
  default: number;
  /** Whether a project can override the global value (02, section 6.5). */
  perProject: boolean;
  /**
   * Version that first uses it (`x.y.z`), for settings added before the version that uses them;
   * absent when in use since lots 0 and 1. Screens say so only while it is later than the running
   * version (`isLaterVersion`).
   */
  usedFrom?: string;
}

/** Whether `version` comes after `current`, both `x.y.z`, compared number by number. */
export function isLaterVersion(version: string, current: string): boolean {
  const a = version.split('.').map(Number);
  const b = current.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

/**
 * Every setting, in display order. The only description of a setting: the server resolves values
 * from it, the screens show it, and `docs/user/settings.md` lists the same names.
 */
const definitions = {
  sessionLifetimeDays: {
    group: 'sessions',
    label: 'Session lifetime',
    description: 'How long a login lasts before you must log in again.',
    unit: 'days',
    min: 1,
    max: 365,
    default: 30,
    perProject: false,
  },
  loginFailuresBeforeDelay: {
    group: 'sessions',
    label: 'Failed logins before a delay',
    description:
      'Failed logins allowed for one username or one address before the next attempt must wait.',
    unit: 'failures',
    min: 1,
    max: 100,
    default: 5,
    perProject: false,
  },
  loginFirstDelaySeconds: {
    group: 'sessions',
    label: 'First login delay',
    description:
      'Wait after the first failure over the limit; it doubles with each further failure.',
    unit: 'seconds',
    min: 1,
    max: 3600,
    default: 10,
    perProject: false,
  },
  loginMaxDelaySeconds: {
    group: 'sessions',
    label: 'Longest login delay',
    description: 'The wait between login attempts never goes above this.',
    unit: 'seconds',
    min: 1,
    max: 86_400,
    default: 900,
    perProject: false,
  },
  loginFailureMemoryMinutes: {
    group: 'sessions',
    label: 'Failed login memory',
    description: 'Failed logins older than this are forgotten.',
    unit: 'minutes',
    min: 1,
    max: 10_080,
    default: 60,
    perProject: false,
  },
  githubTokenExpiryWarningDays: {
    group: 'github',
    label: 'GitHub token expiry warning',
    description: '"Needs you" warns this many days before the GitHub token expires.',
    unit: 'days',
    min: 1,
    max: 90,
    default: 14,
    perProject: false,
  },
  githubRequestTimeoutSeconds: {
    group: 'github',
    label: 'GitHub request timeout',
    description: 'How long the Orchestrator waits for GitHub to answer one request.',
    unit: 'seconds',
    min: 1,
    max: 300,
    default: 15,
    perProject: false,
  },
  githubClockToleranceSeconds: {
    group: 'github',
    label: 'GitHub clock tolerance',
    description:
      "Allowed difference between this computer's clock and GitHub's, when Try again checks whether a repository was created by an earlier attempt.",
    unit: 'seconds',
    min: 0,
    max: 3600,
    default: 120,
    perProject: false,
  },
  githubPollSeconds: {
    group: 'github',
    label: 'GitHub check interval',
    description:
      'How often the Orchestrator asks GitHub about tickets that wait on it, such as a submission waiting for its CI result, or a pull request waiting to be merged.',
    unit: 'seconds',
    min: 15,
    max: 600,
    default: 60,
    perProject: false,
    usedFrom: '0.4.0',
  },
  ticketTitleMaxLength: {
    group: 'tickets',
    label: 'Longest ticket title',
    description: 'Most characters in a ticket title.',
    unit: 'characters',
    min: 1,
    max: 1000,
    default: 200,
    perProject: false,
  },
  ticketDescriptionMaxLength: {
    group: 'tickets',
    label: 'Longest ticket description',
    description: 'Most characters in a ticket description.',
    unit: 'characters',
    min: 1,
    max: 100_000,
    default: 20_000,
    perProject: false,
  },
  ticketMaxAcceptanceCriteria: {
    group: 'tickets',
    label: 'Most acceptance criteria',
    description: 'Most acceptance criteria on one ticket.',
    unit: 'criteria',
    min: 1,
    max: 100,
    default: 20,
    perProject: false,
  },
  acceptanceCriterionMaxLength: {
    group: 'tickets',
    label: 'Longest acceptance criterion',
    description: 'Most characters in one acceptance criterion.',
    unit: 'characters',
    min: 1,
    max: 5000,
    default: 500,
    perProject: false,
  },
  commentMaxLength: {
    group: 'tickets',
    label: 'Longest comment',
    description: 'Most characters in one comment.',
    unit: 'characters',
    min: 1,
    max: 100_000,
    default: 20_000,
    perProject: false,
  },
  maxTicketsPerPlan: {
    group: 'tickets',
    label: 'Most tickets per plan',
    description: 'A plan proposing more tickets than this is refused.',
    unit: 'tickets',
    min: 1,
    max: 100,
    default: 15,
    perProject: true,
    usedFrom: '0.6.0',
  },
  maxAgentTicketsPerRun: {
    group: 'tickets',
    label: 'Most tickets an agent creates per run',
    description: 'Tickets an agent may create during one run, outside a plan.',
    unit: 'tickets',
    min: 0,
    max: 20,
    default: 3,
    perProject: true,
    usedFrom: '0.3.0',
  },
  maxFailedAttempts: {
    group: 'tickets',
    label: 'Failed attempts before asking you',
    description:
      'After this many failed attempts on a ticket, it waits for you instead of trying again.',
    unit: 'attempts',
    min: 1,
    max: 10,
    default: 2,
    perProject: true,
    usedFrom: '0.4.0',
  },
  maxMachineFailures: {
    group: 'tickets',
    label: 'Machine failures before asking you',
    description:
      "After this many failures in a row caused by a machine, not by the ticket's work, the scheduler stops starting the ticket on that machine and asks you.",
    unit: 'failures',
    min: 1,
    max: 10,
    default: 2,
    perProject: false,
    usedFrom: '0.5.0',
  },
  ciWaitTimeoutMinutes: {
    group: 'tickets',
    label: 'CI wait at submission',
    description:
      "How long a run waits for CI on GitHub after the agent's work is accepted. When it is reached, the run stops without counting as a failed attempt, and Needs you offers Check CI again, or Run now when CI had failed or the pull request conflicts.",
    unit: 'minutes',
    min: 1,
    max: 240,
    default: 20,
    perProject: true,
    usedFrom: '0.4.0',
  },
  ciStartWaitMinutes: {
    group: 'tickets',
    label: 'Wait for CI to start',
    description:
      'When no CI run or status appears on GitHub for this long after the pull request is open, the submission passes as "No CI found" (unless the pull request conflicts with its base branch, or is closed on GitHub).',
    unit: 'minutes',
    min: 1,
    max: 60,
    default: 5,
    perProject: true,
    usedFrom: '0.4.0',
  },
  maxCiFailuresPerRun: {
    group: 'tickets',
    label: 'Most CI failures per run',
    description:
      'How many CI failures an agent gets back to fix in one run; a conflict with the default branch counts as one. One more ends the run as a failed attempt.',
    unit: 'failures',
    min: 1,
    max: 10,
    default: 2,
    perProject: true,
    usedFrom: '0.4.0',
  },
  maxReviewRounds: {
    group: 'tickets',
    label: 'Most review rounds per ticket',
    description:
      'How many times Quality may ask for changes on one ticket before it waits for you. One request more is applied, then stops the ticket until you use Try again. Your own Request changes never counts.',
    unit: 'rounds',
    min: 1,
    max: 10,
    default: 2,
    perProject: true,
    usedFrom: '0.4.0',
  },
  ciLogExcerptMaxLength: {
    group: 'tickets',
    label: 'Longest CI log excerpt',
    description: "How much of each failed CI step's log an agent receives, keeping its end.",
    unit: 'characters',
    min: 500,
    max: 20000,
    default: 4000,
    perProject: false,
    usedFrom: '0.4.0',
  },
  ciLogReadMaxMegabytes: {
    group: 'tickets',
    label: 'Longest CI log read',
    description:
      "How much of a failed CI job's log the Orchestrator downloads from GitHub to find each failed step's part. Beyond it, the agent gets the end of what was read and is told so.",
    unit: 'megabytes',
    min: 1,
    max: 500,
    default: 20,
    perProject: false,
    usedFrom: '0.4.0',
  },
  waitingRunLifetimeMinutes: {
    group: 'runs',
    label: 'Waiting run lifetime',
    description:
      'How long a run stays alive after asking you a question; after that it stops and continues when you answer.',
    unit: 'minutes',
    min: 1,
    max: 1440,
    default: 30,
    perProject: false,
    usedFrom: '0.3.0',
  },
  maxRunDurationMinutes: {
    group: 'runs',
    label: 'Longest run',
    description:
      'Working time after which a run is stopped. Time waiting for CI, for you or for the quota does not count.',
    unit: 'minutes',
    min: 1,
    max: 1440,
    default: 90,
    perProject: false,
    usedFrom: '0.3.0',
  },
  idleTimeoutMinutes: {
    group: 'runs',
    label: 'Idle timeout',
    description:
      'A run whose agent shows no activity for this long is stopped. Time waiting for you, for CI or for the quota, and time running a command, does not count.',
    unit: 'minutes',
    min: 1,
    max: 120,
    default: 10,
    perProject: false,
    usedFrom: '0.3.0',
  },
  maxNudgesPerRun: {
    group: 'runs',
    label: 'Most reminders per run',
    description:
      'Reminders sent to an agent that stops without finishing, before the run is stopped.',
    unit: 'reminders',
    min: 0,
    max: 10,
    default: 2,
    perProject: false,
    usedFrom: '0.3.0',
  },
  sessionStartTimeoutSeconds: {
    group: 'runs',
    label: 'Session start timeout',
    description:
      "How long a machine waits for Claude Code to start a run's session; after that the run fails (a startup dialog or a change in Claude Code is likely).",
    unit: 'seconds',
    min: 5,
    max: 600,
    default: 30,
    perProject: false,
    usedFrom: '0.3.0',
  },
  mcpCallTimeoutSeconds: {
    group: 'runs',
    label: 'MCP call timeout',
    description:
      "How long a machine waits for the Orchestrator's answer to an agent's tool call; after that the agent is told to try again later. Below the Claude Code MCP tool timeout.",
    unit: 'seconds',
    min: 5,
    max: 300,
    default: 30,
    perProject: false,
    usedFrom: '0.3.0',
  },
  claudeCodeMcpToolTimeoutSeconds: {
    group: 'runs',
    label: 'Claude Code MCP tool timeout',
    description:
      'How long Claude Code waits for an Orchestrator tool call before giving up on it. Above the MCP call timeout, so the machine always answers first.',
    unit: 'seconds',
    min: 10,
    max: 1800,
    default: 120,
    perProject: false,
    usedFrom: '0.3.0',
  },
  pushTimeoutSeconds: {
    group: 'runs',
    label: 'Longest push',
    description:
      "How long a machine lets one push of a ticket branch take before stopping it. It also limits each download of the project from GitHub when a run starts; the first download on a new machine is the longest, and a run whose download is stopped fails, naming this limit. The MCP call timeout plus this limit must stay below the Claude Code MCP tool timeout, since the push at submission happens inside the agent's tool call.",
    unit: 'seconds',
    min: 10,
    max: 600,
    default: 60,
    perProject: false,
    usedFrom: '0.4.0',
  },
  dispatchAckTimeoutSeconds: {
    group: 'runs',
    label: 'Machine answer timeout',
    description:
      'How long the Orchestrator waits for a machine to confirm it starts a run; without an answer the run is cancelled and does not count as a failed attempt.',
    unit: 'seconds',
    min: 5,
    max: 600,
    default: 60,
    perProject: false,
    usedFrom: '0.3.0',
  },
  progressUpdateIntervalSeconds: {
    group: 'runs',
    label: 'Progress update interval',
    description:
      "Shortest time between two new progress lines shown for a run. The agent's updates are never refused: the latest one is shown when this time has passed.",
    unit: 'seconds',
    min: 0,
    max: 3600,
    default: 60,
    perProject: false,
    usedFrom: '0.3.0',
  },
  logEntryMaxLength: {
    group: 'runs',
    label: 'Longest stored log entry',
    description:
      "Most characters kept of one entry of a run's log, such as a command's output; the rest is cut and the cut is marked.",
    unit: 'characters',
    min: 100,
    max: 100_000,
    default: 2000,
    perProject: false,
    usedFrom: '0.3.0',
  },
  enrollmentCodeLifetimeMinutes: {
    group: 'machines',
    label: 'Enrollment code lifetime',
    description:
      'How long the code shown by Add machine can be used to connect the machine; after that, generate a new code.',
    unit: 'minutes',
    min: 1,
    max: 1440,
    default: 15,
    perProject: false,
  },
  heartbeatIntervalSeconds: {
    group: 'machines',
    label: 'Heartbeat interval',
    description:
      'How often a connected machine tells the Orchestrator it is still there. A machine uses the value it received when it connected.',
    unit: 'seconds',
    min: 5,
    max: 120,
    default: 15,
    perProject: false,
  },
  machineOfflineAfterSeconds: {
    group: 'machines',
    label: 'Machine offline after',
    description:
      'A machine that sends nothing for this long is shown offline. At least twice the heartbeat interval.',
    unit: 'seconds',
    min: 15,
    max: 600,
    default: 60,
    perProject: false,
  },
  schedulerTickSeconds: {
    group: 'scheduler',
    label: 'Scheduler check interval',
    description: 'The scheduler looks for work to start at least this often.',
    unit: 'seconds',
    min: 5,
    max: 600,
    default: 30,
    perProject: false,
    usedFrom: '0.5.0',
  },
  quotaFallbackDelayMinutes: {
    group: 'scheduler',
    label: 'Quota wait when the reset time is unknown',
    description:
      'When the Claude usage limit is reached without a reset time, the account waits this long; the wait doubles each time the limit is still reached. A run paused on a possible limit waits this long too before the scheduler resumes it, doubling the same way.',
    unit: 'minutes',
    min: 1,
    max: 1440,
    default: 60,
    perProject: false,
    usedFrom: '0.3.0',
  },
  quotaFallbackMaxDelayMinutes: {
    group: 'scheduler',
    label: 'Longest quota wait',
    description: 'The doubling wait above never goes above this.',
    unit: 'minutes',
    min: 1,
    max: 2880,
    default: 240,
    perProject: false,
    usedFrom: '0.5.0',
  },
  maxSchedulerResumes: {
    group: 'scheduler',
    label: 'Most resumes per run',
    description:
      'How many times the scheduler resumes one run paused on a Claude usage limit, detected or possible. Once reached, the run waits for you in Needs you; your own Resume does not count and starts the count again.',
    unit: 'resumes',
    min: 1,
    max: 50,
    default: 6,
    perProject: false,
    usedFrom: '0.5.0',
  },
} satisfies Record<string, SettingDefinition>;

export type SettingName = keyof typeof definitions;
export const SETTINGS: Readonly<Record<SettingName, Readonly<SettingDefinition>>> = definitions;
export const SettingName = z.enum(Object.keys(SETTINGS) as [SettingName, ...SettingName[]]);

/**
 * Pairs of settings whose values must stay in order (04, section 8; 07, section 8): `factor`
 * times `smaller` is never above `larger`, and is below it when `strict`. A change or reset
 * breaking the order is refused with `setting_order_invalid`, naming both settings and their
 * values. Both settings of a pair are global only, so no project override can break the order.
 */
export interface SettingOrder {
  smaller: SettingName;
  larger: SettingName;
  /** `larger` must be at least this many times `smaller` (1: never above). */
  factor: number;
  /** `smaller` times `factor` must be strictly below `larger`. */
  strict: boolean;
}

export const SETTING_ORDER: readonly SettingOrder[] = [
  { smaller: 'loginFirstDelaySeconds', larger: 'loginMaxDelaySeconds', factor: 1, strict: false },
  {
    smaller: 'quotaFallbackDelayMinutes',
    larger: 'quotaFallbackMaxDelayMinutes',
    factor: 1,
    strict: false,
  },
  // One lost heartbeat never marks a machine offline (05, section 3.2).
  {
    smaller: 'heartbeatIntervalSeconds',
    larger: 'machineOfflineAfterSeconds',
    factor: 2,
    strict: false,
  },
  // The machine always answers a tool call (UNAVAILABLE) before Claude Code gives up on it (06, section 1).
  {
    smaller: 'mcpCallTimeoutSeconds',
    larger: 'claudeCodeMcpToolTimeoutSeconds',
    factor: 1,
    strict: true,
  },
];

/**
 * Most characters the acceptance criteria of one ticket can take (03, section 3.2): counting 4
 * bytes per character (UTF-8's largest), 80,000 of the `FIRST_MESSAGE_MAX_BYTES` of a run's first
 * message, leaving 20,000 bytes for the rest of it.
 */
export const FIRST_MESSAGE_CRITERIA_MAX_CHARACTERS = 20_000;

/**
 * Pairs of settings whose product has a ceiling (04, section 8): `first` times `second` is never
 * above `max`. A change or reset breaking it is refused with `setting_product_invalid`, naming
 * both settings, their values and the ceiling. Both settings are global only.
 */
export interface SettingProduct {
  first: SettingName;
  second: SettingName;
  max: number;
  /** Unit of the product, as the refusal states it. */
  unit: string;
}

export const SETTING_PRODUCTS: readonly SettingProduct[] = [
  // The criteria of any valid ticket fit in a run's first message (owner's decision, review of
  // lot 2 step I).
  {
    first: 'ticketMaxAcceptanceCriteria',
    second: 'acceptanceCriterionMaxLength',
    max: FIRST_MESSAGE_CRITERIA_MAX_CHARACTERS,
    unit: 'characters',
  },
];

/**
 * Settings whose sum must stay below another setting (04, section 8): the `parts` added together
 * are strictly below `below`. A change or reset breaking it is refused with
 * `setting_sum_invalid`, naming the three settings and their values. All are global only.
 */
export interface SettingSum {
  parts: readonly [SettingName, SettingName];
  below: SettingName;
}

export const SETTING_SUMS: readonly SettingSum[] = [
  // The push at submission happens inside the agent's `ticket_submit` call, before the machine
  // waits for the Orchestrator's answer: both fit in Claude Code's wait (owner's decision, lot 3
  // step D).
  {
    parts: ['mcpCallTimeoutSeconds', 'pushTimeoutSeconds'],
    below: 'claudeCodeMcpToolTimeoutSeconds',
  },
];

/** Whether the values of a pair of `SETTING_ORDER` are in order. */
export function inOrder(order: SettingOrder, smallerValue: number, largerValue: number): boolean {
  const limit = order.factor * smallerValue;
  return order.strict ? limit < largerValue : limit <= largerValue;
}

/** Resolved values of settings, by name. */
export type SettingValues = { [Name in SettingName]: number };

/** Names of the settings a project can override. */
export const PROJECT_SETTINGS = SettingName.options.filter((name) => SETTINGS[name].perProject);

/** Checks a value against the setting's allowed range; the error message names the range. */
export function settingValue(name: SettingName) {
  const { min, max, unit } = SETTINGS[name];
  return z
    .int(`must be a whole number of ${unit}`)
    .min(min, `must be between ${String(min)} and ${String(max)} ${unit}`)
    .max(max, `must be between ${String(min)} and ${String(max)} ${unit}`);
}

/** `PUT /api/settings/:name` and `PUT /api/projects/:key/settings/:name`. */
export const SetSettingRequest = z.object({ value: z.int() });
export type SetSettingRequest = z.infer<typeof SetSettingRequest>;

/** One setting on Settings > Limits: its value, and whether it is only the default. */
export const GlobalSetting = z.object({
  name: SettingName,
  value: z.int(),
  /** True when the owner never changed it or reset it: the value is the default. */
  isDefault: z.boolean(),
});
export type GlobalSetting = z.infer<typeof GlobalSetting>;

/** `GET /api/settings`: every setting, in the order of `SETTINGS`. */
export const GlobalSettingsResponse = z.object({ settings: z.array(GlobalSetting) });
export type GlobalSettingsResponse = z.infer<typeof GlobalSettingsResponse>;

/** One overridable setting in project settings. */
export const ProjectSetting = z.object({
  name: SettingName,
  /** The project's own value, or null when it uses the global value. */
  override: z.int().nullable(),
  /** Global value (or default) used when there is no override. */
  globalValue: z.int(),
});
export type ProjectSetting = z.infer<typeof ProjectSetting>;

/** `GET /api/projects/:key/settings`: the settings a project can override. */
export const ProjectSettingsResponse = z.object({ settings: z.array(ProjectSetting) });
export type ProjectSettingsResponse = z.infer<typeof ProjectSettingsResponse>;

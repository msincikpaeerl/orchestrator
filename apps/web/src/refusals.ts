import {
  SETTINGS,
  type ApiErrorCode,
  type CheckCiAgainRefused,
  type LimitExceeded,
} from '@orchestrator/protocol';
import { ApiRequestError } from './api';
import { formatDateTime } from './github/text';
import { runRefusalText } from './runs/text';
import { amount } from './settings/text';

/** Shown when the refusal is not one of the API's: a bug or a network problem. */
export const UNEXPECTED_TEXT = 'Something went wrong. Try again.';

/** The text ending with a full stop, whether or not it already had one. */
export function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function count(value: number): string {
  return value.toLocaleString('en-US');
}

function waitText(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return minutes === 1 ? '1 minute' : `${String(minutes)} minutes`;
}

/** One field over its limit, named as the form names it (04, section 8). */
export function limitText({ field, index, max }: LimitExceeded): string {
  switch (field) {
    case 'title':
      return `The title can have at most ${count(max)} characters.`;
    case 'description':
      return `The description can have at most ${count(max)} characters.`;
    case 'acceptance_criteria':
      return `A ticket can have at most ${count(max)} acceptance criteria.`;
    case 'acceptance_criterion':
      return `Acceptance criterion ${String((index ?? 0) + 1)} can have at most ${count(max)} characters.`;
    case 'comment':
      return `A comment can have at most ${count(max)} characters.`;
    case 'request':
      return `A request can have at most ${count(max)} characters.`;
  }
}

/**
 * Every refusal of the API in plain words (02, section 1: the owner never reads codes). A code
 * added to `ApiErrorCode` without a text here fails the type check and the unit test.
 */
const texts: Record<ApiErrorCode, (error: ApiRequestError) => string> = {
  invalid_request: (error) =>
    error.limits && error.limits.length > 0
      ? error.limits.map(limitText).join(' ')
      : 'Some fields are not valid. Check them and try again.',
  not_found: () => 'This address does not exist in the Orchestrator. Reload the page.',
  not_authenticated: () => 'Your session has ended. Log in again.',
  owner_exists: () => 'The owner account already exists. Log in instead.',
  invalid_credentials: () => 'Wrong username or password.',
  too_many_attempts: (error) =>
    `Too many failed attempts. Wait ${waitText(error.retryAfterSeconds ?? 60)} before trying again.`,
  github_not_connected: () =>
    'GitHub is not connected. Connect it in Settings > GitHub connection first.',
  github_token_invalid: () =>
    'GitHub does not accept the token. Check that you copied all of it, or create a new one.',
  github_token_not_fine_grained: () =>
    'This is not a fine-grained personal access token. Create one with the "Create the token on GitHub" button.',
  github_token_unreadable: () =>
    'The saved GitHub token cannot be read any more (the secret key changed). Enter it again in Settings > GitHub connection.',
  github_unreachable: () =>
    'GitHub could not be reached. Check the internet connection and try again.',
  expiry_date_in_past: () =>
    'The expiry date is in the past. Enter the date GitHub showed, or create a new token.',
  github_request_failed: (error) => `GitHub refused the request. ${sentence(error.message)}`,
  project_not_found: () => 'This project does not exist.',
  project_key_taken: () =>
    'Another project already uses this key (archived projects count too). Choose another key.',
  repository_name_taken: () =>
    'A repository with this name already exists on your GitHub account. Choose another name, or link that repository instead.',
  repository_not_found: () =>
    'This repository is no longer on your GitHub account. Choose another one.',
  repository_archived: () =>
    'This repository is archived on GitHub. Unarchive it on GitHub first, or choose another one.',
  repository_already_linked: () =>
    'This repository is already linked to another project. Choose another one.',
  project_archived: () => 'This project is archived. Unarchive it first.',
  project_not_archived: () => 'This project is not archived any more.',
  project_setup_in_progress: () =>
    'The repository setup is running. Wait until it is finished, then try again.',
  project_setup_not_failed: () => 'The setup has not failed any more: nothing to try again.',
  project_not_linked: () => 'Harness elements are only checked for linked repositories.',
  project_not_ready: () => 'The repository setup is not finished. Use Try again first.',
  ticket_not_found: () => 'This ticket does not exist in this project. Reload the page.',
  request_not_found: () => 'This request does not exist. Reload the page.',
  ticket_not_editable: () =>
    'This ticket can be changed only while it is Proposed or To do. The page now shows its current state.',
  agent_not_found: () =>
    'This agent profile does not exist. Reload the page and choose another assignee.',
  agent_not_assignable: () =>
    'This agent reviews the work of other agents and cannot be assigned a ticket. Choose another assignee.',
  ticket_transition_not_allowed: () =>
    'This action is not possible in the ticket’s current state. The page now shows its current state and the actions it allows.',
  dependency_on_itself: () => 'A ticket cannot wait for itself. Choose another ticket.',
  ticket_import_invalid: () =>
    'Nothing was imported: the file has problems. They are listed below; correct them and preview again.',
  dependency_cycle: (error) =>
    error.cycle && error.cycle.length > 1
      ? `Refused: this would make a loop in which each ticket waits for the next, so none of them could ever start: ${error.cycle.join(' → ')}.`
      : 'Refused: this would make a loop of tickets waiting for each other, so none of them could ever start.',
  dependency_not_found: () => 'This dependency was already removed. Reload the page.',
  setting_not_found: () =>
    'This setting does not exist in this version of the Orchestrator. Reload the page.',
  setting_not_per_project: () =>
    'This setting cannot be changed for one project. Change it in Settings > Limits.',
  setting_order_invalid: ({ settingOrder: order }) => {
    if (!order) {
      return 'This value would put two related limits in the wrong order. Check both and try again.';
    }
    const larger = `${SETTINGS[order.larger].label} (${amount(order.larger, order.largerValue)})`;
    const smaller = `${SETTINGS[order.smaller].label} (${amount(order.smaller, order.smallerValue)})`;
    const rule = order.strict
      ? `must be more than ${order.factor === 1 ? '' : `${String(order.factor)} times `}`
      : order.factor === 1
        ? 'cannot be less than '
        : order.factor === 2
          ? 'must be at least twice '
          : `must be at least ${String(order.factor)} times `;
    return `${larger} ${rule}${smaller}. Change the other one first, or choose another value.`;
  },
  setting_product_invalid: ({ settingProduct: product }) => {
    if (!product) {
      return 'This value would make two related limits too large together. Check both and try again.';
    }
    const first = `${SETTINGS[product.first].label} (${amount(product.first, product.firstValue)})`;
    const second = `${SETTINGS[product.second].label} (${amount(product.second, product.secondValue)})`;
    const total = count(product.firstValue * product.secondValue);
    return `${first} times ${second} is ${total} ${product.unit}, above the ${count(product.max)} ${product.unit} a run's first message has room for. Lower one of them.`;
  },
  setting_sum_invalid: ({ settingSum: sum }) => {
    if (!sum) {
      return 'This value would make two limits together too long for a third one. Check them and try again.';
    }
    const [first, second] = sum.parts.map(
      (part) => `${SETTINGS[part.name].label} (${amount(part.name, part.value)})`,
    );
    const below = `${SETTINGS[sum.below.name].label} (${amount(sum.below.name, sum.below.value)})`;
    return `${first ?? ''} plus ${second ?? ''} must be less than ${below}. Change one of them first, or choose another value.`;
  },
  account_not_found: () => 'This Claude account no longer exists. Reload the page.',
  account_label_taken: () =>
    'Another Claude account already has this label. Choose a different label.',
  machine_not_found: () => 'This machine no longer exists. Reload the page.',
  machine_name_taken: () => 'Another machine already has this name. Choose a different name.',
  machine_revoked: () =>
    'This machine is revoked. To use it again, generate a new enrollment code on its page.',
  machine_already_enrolled: () =>
    'This machine is already enrolled. Revoke it first if you need to enroll it again.',
  machine_not_enrolled: () =>
    'This machine has not connected yet, so there is nothing to revoke. Its enrollment code simply expires.',
  enrollment_code_unknown: () =>
    'No machine has this enrollment code. Check it, or generate a new code in Machines.',
  enrollment_code_used: () =>
    'This enrollment code was already used. Generate a new code in Machines.',
  enrollment_code_expired: ({ setting }) =>
    setting
      ? `This enrollment code expired: codes are valid for ${amount(setting.name, setting.value)} (${SETTINGS[setting.name].label}). Generate a new code in Machines.`
      : 'This enrollment code expired. Generate a new code in Machines.',
  run_not_possible: ({ runRefusal }) =>
    runRefusal ? runRefusalText(runRefusal) : 'The run cannot start now. Reload the page.',
  run_not_found: () => 'This run no longer exists. Reload the page.',
  run_not_active: () => 'This run already ended. Reload the page.',
  no_open_question: () =>
    'This ticket has no question waiting for an answer: it may have been answered already. Reload the page.',
  no_pull_request_wanted: () =>
    'This ticket no longer waits for its pull request: it was opened already, or the ticket is done or cancelled. Reload the page.',
  pull_request_not_closed: () =>
    'This pull request is not closed without merging any more, or the ticket is done or cancelled. Reload the page.',
  ci_check_refused: ({ ciRefusal }) => checkCiAgainRefusalText(ciRefusal),
  review_active: () =>
    'Quality is reviewing this ticket now: wait for the review to end, or stop its run first.',
  ticket_not_stopped: () => 'This ticket is not stopped any more. Reload the page.',
  request_not_stopped: () => 'This request is not stopped any more. Reload the page.',
  plan_not_proposed: () =>
    'This plan is no longer waiting for your review: it was approved, rejected or replaced. Reload the page.',
  plan_new_project_later: () =>
    'A plan that creates a new project cannot be approved yet: reject it with feedback, or close the request.',
  plan_invalid: () => 'The plan has problems. They are listed below; correct them and try again.',
  plan_ticket_not_found: () => 'This ticket is no longer in the plan. Reload the page.',
  plan_last_ticket: () =>
    'This is the only ticket of the plan: it cannot be removed. Reject the plan with feedback, or close the request.',
  plan_bootstrap_fixed: () =>
    "The bootstrap ticket's type, assignee and dependencies cannot change, and it cannot be removed: every other ticket of the new project waits for it.",
  request_closed: () => 'This request is closed. Reload the page.',
};

/** Why **Check CI again** was refused, in the words of the owner's table (lot 3 step G2c). */
export function checkCiAgainRefusalText(refused: CheckCiAgainRefused | undefined): string {
  switch (refused?.reason) {
    case 'run_active':
      return 'A run is working on this ticket: its own submission will be checked.';
    case 'newer_work':
      return `This ticket has newer work${refused.acceptedAt === undefined ? '' : `, accepted on ${formatDateTime(refused.acceptedAt)}`}: its own CI decides.`;
    case 'not_offered':
      return 'Check CI again is not offered for this ticket now: its latest work was accepted, or Run now continues it. Reload the page.';
    case 'no_pull_request':
      return 'This ticket has no pull request on GitHub yet: Try again in “Pull request not opened” opens it.';
    case 'branch_moved':
      return `The branch changed on GitHub after commit ${(refused.commit ?? '').slice(0, 7)} (it is now ${(refused.head ?? '').slice(0, 7)}), so this result would not be about the latest work. Run now hands the work in again.`;
    case 'pull_request_closed':
      return `Pull request #${String(refused.pullRequest ?? '')} is closed on GitHub, so the work cannot be accepted.`;
    case 'pull_request_merged':
      return `Pull request #${String(refused.pullRequest ?? '')} was merged on GitHub. Use Mark as done manually.`;
    case undefined:
      return 'Check CI again was refused. Reload the page.';
  }
}

/** A refusal of the API in plain words. Never shows the code. */
export function refusalText(error: unknown): string {
  if (!(error instanceof ApiRequestError)) return UNEXPECTED_TEXT;
  if (error.code === 'unexpected') {
    return error.status === 0
      ? 'The Orchestrator could not be reached. Try again.'
      : UNEXPECTED_TEXT;
  }
  return texts[error.code](error);
}

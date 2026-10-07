import { pullRequestEvent, syncBranches, type FakeContext } from './actions.js';
import type {
  FakeAccount,
  FakePullRequest,
  FakeReply,
  FakeReview,
  Json,
  RepositoryState,
} from './common.js';
import { has, notFound, paged, refuse, unprocessable } from './common.js';

// Pull requests and reviews of the fake GitHub. Sources (REST API 2026-03-10):
//
// - "REST API endpoints for pull requests" (https://docs.github.com/en/rest/pulls/pulls): list
//   (`state` open by default, `head` as `owner:branch`, `base`), create (`head`, `base`, `title`,
//   `body`, `draft`; 201), get, update (`title`, `body`, `state` open or closed, `base`; 200), and
//   "check if merged" (204 merged, 404 not). "When you get, create, or edit a pull request, GitHub
//   creates a merge commit to test whether the pull request can be automatically merged [...] If
//   the value is null, then GitHub has started a background job to compute the mergeability.
//   After giving the job time to complete, resubmit the request": here the first read after a
//   change of the head or the base answers null, and the next one the computed value.
// - "Update a pull request branch" merges "HEAD from the base branch into the pull request
//   branch", and is offered only "when there are no merge conflicts and the branch is behind the
//   base branch" ("Keeping your pull request in sync with the base branch",
//   https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/keeping-your-pull-request-in-sync-with-the-base-branch).
// - Reviews: `POST .../pulls/{pull_number}/reviews` with `event` APPROVE, REQUEST_CHANGES or
//   COMMENT, `body` "required when using REQUEST_CHANGES or COMMENT"; no event leaves a PENDING
//   review ("REST API endpoints for pull request reviews",
//   https://docs.github.com/en/rest/pulls/reviews). "Pull request authors cannot approve their
//   own pull requests" ("Approving a pull request with required reviews",
//   https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/approving-a-pull-request-with-required-reviews).
//   The 422 texts for your own pull request and for create are the fake's, from GitHub's known
//   answers: lot 3 step E confirms them.
// - Permissions: Pull requests write to create, update and review; Pull requests read to list,
//   check merged and list reviews; Pull requests read or Contents read to get one. Merging needs
//   Contents write: the owner merges on GitHub's site, so the fake offers it as a test control.

/** Mergeability as GitHub reports it: null once after any change of the head or the base. */
function readMergeable(state: RepositoryState, pull: FakePullRequest): boolean | null {
  if (pull.state !== 'open') return pull.mergeability?.mergeable ?? null;
  const base = state.store.branch(pull.base) ?? '';
  const known = pull.mergeability;
  if (known && known.head === pull.headSha && known.base === base) return known.mergeable;
  pull.mergeability = {
    head: pull.headSha,
    base,
    mergeable: base !== '' && state.store.mergeTree(base, pull.headSha) !== null,
  };
  return null;
}

/**
 * "pull-request-simple", as lists give it: no `merged` or `mergeable`. The fields the fake does
 * not model are added by `shaped` (fake-github/documented.ts); `merge_commit_sha` is gone since
 * version 2026-03-10 ("Breaking changes",
 * https://docs.github.com/en/rest/about-the-rest-api/breaking-changes).
 */
function pullSimpleJson(ctx: FakeContext, state: RepositoryState, pull: FakePullRequest): Json {
  const repoPath = `${state.owner}/${state.repo.name}`;
  const baseSha = state.store.branch(pull.base) ?? '';
  const user = { login: pull.user };
  const branchJson = (ref: string, sha: string) => ({
    label: `${state.owner}:${ref}`,
    ref,
    sha,
    user: { login: state.owner },
    repo: {
      name: state.repo.name,
      full_name: repoPath,
      owner: { login: state.owner },
      private: state.repo.private,
      default_branch: state.repo.defaultBranch ?? 'main',
    },
  });
  return {
    id: pull.number,
    number: pull.number,
    url: `${ctx.url}/repos/${repoPath}/pulls/${String(pull.number)}`,
    html_url: `${ctx.url}/${repoPath}/pull/${String(pull.number)}`,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    draft: pull.draft,
    user,
    head: branchJson(pull.head, pull.headSha),
    base: branchJson(pull.base, baseSha),
    merged_at: pull.mergedAt,
    closed_at: pull.closedAt,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

/** "pull-request", as get, create and update give it. */
function pullJson(ctx: FakeContext, state: RepositoryState, pull: FakePullRequest): Json {
  const mergeable = readMergeable(state, pull);
  return {
    ...pullSimpleJson(ctx, state, pull),
    merged: pull.merged,
    mergeable,
    mergeable_state: mergeable === null ? 'unknown' : mergeable ? 'clean' : 'dirty',
  };
}

function reviewJson(
  ctx: FakeContext,
  state: RepositoryState,
  pull: FakePullRequest,
  review: FakeReview,
): Json {
  const repoPath = `${state.owner}/${state.repo.name}`;
  return {
    id: review.id,
    user: { login: review.user },
    body: review.body,
    state: review.state,
    commit_id: review.commitId,
    html_url: `${ctx.url}/${repoPath}/pull/${String(pull.number)}#pullrequestreview-${String(review.id)}`,
    ...(review.submittedAt === null ? {} : { submitted_at: review.submittedAt }),
  };
}

/** An open pull request already using this head and base. */
function duplicate(state: RepositoryState, head: string, base: string, except?: FakePullRequest) {
  return state.pulls.find(
    (pull) => pull !== except && pull.state === 'open' && pull.head === head && pull.base === base,
  );
}

function alreadyExists(state: RepositoryState, head: string): FakeReply {
  return unprocessable('Validation Failed', [
    {
      resource: 'PullRequest',
      code: 'custom',
      message: `A pull request already exists for ${state.owner}:${head}.`,
    },
  ]);
}

function createPull(
  ctx: FakeContext,
  account: FakeAccount,
  state: RepositoryState,
  body: Json,
): FakeReply {
  for (const field of ['head', 'base', 'title'] as const) {
    if (typeof body[field] !== 'string' || body[field] === '') {
      return unprocessable('Validation Failed', [
        { resource: 'PullRequest', field, code: 'missing_field' },
      ]);
    }
  }
  const headText = String(body.head);
  const head = headText.startsWith(`${state.owner}:`)
    ? headText.slice(state.owner.length + 1)
    : headText;
  const base = String(body.base);
  const headSha = state.store.branch(head);
  const baseSha = state.store.branch(base);
  if (headSha === undefined) {
    return unprocessable('Validation Failed', [
      { resource: 'PullRequest', field: 'head', code: 'invalid' },
    ]);
  }
  if (baseSha === undefined) {
    return unprocessable('Validation Failed', [
      { resource: 'PullRequest', field: 'base', code: 'invalid' },
    ]);
  }
  if (duplicate(state, head, base)) return alreadyExists(state, head);
  if (state.store.isAncestor(headSha, baseSha)) {
    return unprocessable('Validation Failed', [
      {
        resource: 'PullRequest',
        code: 'custom',
        message: `No commits between ${base} and ${head}`,
      },
    ]);
  }
  const created = ctx.now();
  const pull: FakePullRequest = {
    number: state.pulls.length + 1,
    title: String(body.title),
    body: typeof body.body === 'string' ? body.body : null,
    state: 'open',
    draft: body.draft === true,
    user: account.login,
    head,
    base,
    headSha,
    merged: false,
    mergedAt: null,
    closedAt: null,
    createdAt: created,
    updatedAt: created,
    mergeability: null,
    reviews: [],
  };
  state.pulls.push(pull);
  pullRequestEvent(ctx, state, pull);
  return { status: 201, body: pullJson(ctx, state, pull) };
}

function updatePull(
  ctx: FakeContext,
  state: RepositoryState,
  pull: FakePullRequest,
  body: Json,
): FakeReply {
  if (body.base !== undefined) {
    if (typeof body.base !== 'string' || state.store.branch(body.base) === undefined) {
      return unprocessable('Validation Failed', [
        { resource: 'PullRequest', field: 'base', code: 'invalid' },
      ]);
    }
  }
  if (body.state === 'open' && pull.state === 'closed') {
    const headSha = state.store.branch(pull.head);
    // A merged pull request, or one whose branch is gone, cannot be reopened (lot 3 step E).
    if (pull.merged || headSha === undefined) {
      return unprocessable('Validation Failed', [
        {
          resource: 'PullRequest',
          code: 'custom',
          message:
            'State cannot be changed. The repository may have been deleted or the head branch removed.',
        },
      ]);
    }
    if (duplicate(state, pull.head, typeof body.base === 'string' ? body.base : pull.base, pull)) {
      return alreadyExists(state, pull.head);
    }
  } else if (body.state !== undefined && body.state !== 'open' && body.state !== 'closed') {
    return unprocessable('Validation Failed', [
      { resource: 'PullRequest', field: 'state', code: 'invalid' },
    ]);
  }
  if (typeof body.title === 'string') pull.title = body.title;
  if (typeof body.body === 'string') pull.body = body.body;
  if (typeof body.base === 'string') pull.base = body.base;
  pull.updatedAt = ctx.now();
  if (body.state === 'closed' && pull.state === 'open') {
    pull.state = 'closed';
    pull.closedAt = pull.updatedAt;
  } else if (body.state === 'open' && pull.state === 'closed') {
    pull.state = 'open';
    pull.closedAt = null;
    pull.headSha = state.store.branch(pull.head) ?? pull.headSha;
    pullRequestEvent(ctx, state, pull);
  }
  // "When you [...] edit a pull request", GitHub computes the test merge again.
  pull.mergeability = null;
  return { status: 200, body: pullJson(ctx, state, pull) };
}

function createReview(
  ctx: FakeContext,
  account: FakeAccount,
  state: RepositoryState,
  pull: FakePullRequest,
  body: Json,
): FakeReply {
  const event = typeof body.event === 'string' ? body.event : undefined;
  if (
    body.event !== undefined &&
    (event === undefined || !['APPROVE', 'REQUEST_CHANGES', 'COMMENT'].includes(event))
  ) {
    return unprocessable('Validation Failed', [
      { resource: 'PullRequestReview', field: 'event', code: 'invalid' },
    ]);
  }
  const text = typeof body.body === 'string' ? body.body : '';
  if ((event === 'REQUEST_CHANGES' || event === 'COMMENT') && text === '') {
    return unprocessable('Validation Failed', [
      { resource: 'PullRequestReview', field: 'body', code: 'missing_field' },
    ]);
  }
  if (pull.user === account.login && event === 'APPROVE') {
    return unprocessable('Unprocessable Entity', ['Review Can not approve your own pull request']);
  }
  if (pull.user === account.login && event === 'REQUEST_CHANGES') {
    return unprocessable('Unprocessable Entity', [
      'Review Can not request changes on your own pull request',
    ]);
  }
  const review: FakeReview = {
    id: ctx.nextId(),
    user: account.login,
    body: text,
    state:
      event === 'APPROVE'
        ? 'APPROVED'
        : event === 'REQUEST_CHANGES'
          ? 'CHANGES_REQUESTED'
          : event === 'COMMENT'
            ? 'COMMENTED'
            : 'PENDING',
    commitId: typeof body.commit_id === 'string' ? body.commit_id : pull.headSha,
    submittedAt: event === undefined ? null : ctx.now(),
  };
  pull.reviews.push(review);
  return { status: 200, body: reviewJson(ctx, state, pull, review) };
}

/** The pull request endpoints; undefined when the request is none of them. */
export function pullsApi(
  ctx: FakeContext,
  account: FakeAccount,
  state: RepositoryState,
  method: string,
  rest: string,
  url: URL,
  body: Json,
): FakeReply | undefined {
  if (rest === '/pulls') {
    if (method === 'POST') {
      if (!has(account, 'pull_requests', 'write')) return refuse(account, ['pull_requests=write']);
      return createPull(ctx, account, state, body);
    }
    if (method === 'GET') {
      if (!has(account, 'pull_requests', 'read')) return refuse(account, ['pull_requests=read']);
      const wanted = url.searchParams.get('state') ?? 'open';
      const head = url.searchParams.get('head');
      const base = url.searchParams.get('base');
      const pulls = state.pulls
        .filter(
          (pull) =>
            (wanted === 'all' || pull.state === wanted) &&
            (head === null || `${state.owner}:${pull.head}` === head) &&
            (base === null || pull.base === base),
        )
        .reverse();
      return {
        status: 200,
        body: paged(pulls, url).map((pull) => pullSimpleJson(ctx, state, pull)),
      };
    }
    return undefined;
  }
  const match = /^\/pulls\/(\d+)(\/merge|\/reviews)?$/.exec(rest);
  if (!match) return undefined;
  const pull = state.pulls.find((candidate) => String(candidate.number) === match[1]);
  const part = match[2];
  if (method === 'GET' && part === undefined) {
    if (!has(account, 'pull_requests', 'read') && !has(account, 'contents', 'read')) {
      return refuse(account, ['pull_requests=read'], ['contents=read']);
    }
    return pull ? { status: 200, body: pullJson(ctx, state, pull) } : notFound;
  }
  if (method === 'PATCH' && part === undefined) {
    if (!has(account, 'pull_requests', 'write')) return refuse(account, ['pull_requests=write']);
    return pull ? updatePull(ctx, state, pull, body) : notFound;
  }
  if (method === 'GET' && part === '/merge') {
    if (!has(account, 'pull_requests', 'read')) return refuse(account, ['pull_requests=read']);
    return pull?.merged ? { status: 204 } : notFound;
  }
  if (part === '/reviews') {
    if (method === 'POST') {
      if (!has(account, 'pull_requests', 'write')) return refuse(account, ['pull_requests=write']);
      return pull ? createReview(ctx, account, state, pull, body) : notFound;
    }
    if (method === 'GET') {
      if (!has(account, 'pull_requests', 'read')) return refuse(account, ['pull_requests=read']);
      if (!pull) return notFound;
      return {
        status: 200,
        body: paged(pull.reviews, url).map((review) => reviewJson(ctx, state, pull, review)),
      };
    }
  }
  return undefined;
}

// The owner's actions on GitHub's site, as test controls. Each throws when GitHub would not
// offer it.

function openPull(state: RepositoryState, number: number): FakePullRequest {
  const pull = state.pulls.find((candidate) => candidate.number === number);
  if (!pull) throw new Error(`no pull request #${String(number)} in ${state.repo.name}`);
  if (pull.state !== 'open') throw new Error(`pull request #${String(number)} is not open`);
  return pull;
}

/** Merges with a merge commit (`merge`) or one squashed commit (`squash`) on the base branch. */
export function mergePull(
  ctx: FakeContext,
  state: RepositoryState,
  number: number,
  method: 'merge' | 'squash' = 'merge',
): string {
  const pull = openPull(state, number);
  const base = state.store.branch(pull.base);
  if (base === undefined) throw new Error(`base branch ${pull.base} is gone`);
  const tree = state.store.mergeTree(base, pull.headSha);
  if (tree === null)
    throw new Error(`pull request #${String(number)} has conflicts with ${pull.base}`);
  const sha =
    method === 'merge'
      ? state.store.commitTree(
          tree,
          [base, pull.headSha],
          `Merge pull request #${String(number)} from ${state.owner}/${pull.head}\n\n${pull.title}`,
        )
      : state.store.commitTree(tree, [base], `${pull.title} (#${String(number)})`);
  state.store.setBranch(pull.base, sha, base);
  const time = ctx.now();
  Object.assign(pull, {
    state: 'closed',
    merged: true,
    mergedAt: time,
    closedAt: time,
    updatedAt: time,
  });
  syncBranches(ctx, state);
  return sha;
}

/** Closes without merging. */
export function closePull(ctx: FakeContext, state: RepositoryState, number: number): void {
  const pull = openPull(state, number);
  pull.state = 'closed';
  pull.closedAt = ctx.now();
  pull.updatedAt = pull.closedAt;
}

/** **Update branch**: merges the base branch into the head branch. */
export function updatePullBranch(ctx: FakeContext, state: RepositoryState, number: number): string {
  const pull = openPull(state, number);
  const base = state.store.branch(pull.base);
  const head = state.store.branch(pull.head);
  if (base === undefined || head === undefined)
    throw new Error('a branch of the pull request is gone');
  if (state.store.isAncestor(base, head))
    throw new Error(`${pull.head} is not behind ${pull.base}`);
  const tree = state.store.mergeTree(head, base);
  if (tree === null)
    throw new Error(`pull request #${String(number)} has conflicts with ${pull.base}`);
  const sha = state.store.commitTree(
    tree,
    [head, base],
    `Merge branch '${pull.base}' into ${pull.head}`,
  );
  state.store.setBranch(pull.head, sha, head);
  syncBranches(ctx, state);
  return sha;
}

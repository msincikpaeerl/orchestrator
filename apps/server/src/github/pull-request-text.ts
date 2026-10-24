import { isLoopback, maskSecrets, type StoredDodReport } from '@orchestrator/protocol';
import type { Template } from '../agents/files.js';
import { fill, part } from '../agents/messages.js';

// The pull request's title and description (04, section 3.1; lot 3 step F3), from the template
// `agents/templates/pull-request.md`. Every text from the ticket or the agent is made harmless
// first: no secret, no HTML, no mention, issue reference or closing keyword.

/**
 * The longest description and title the Orchestrator sends. GitHub documents neither: these are
 * the limits it is known to apply (lot 3 plan, A27, checked by the owner in step N).
 */
export const PULL_REQUEST_BODY_MAX_LENGTH = 65_536;
export const PULL_REQUEST_TITLE_MAX_LENGTH = 256;

const ZERO_WIDTH_SPACE = '​';

// One segment of a local path: no separator, no space, no quote or bracket around a path.
const SEGMENT = String.raw`[^\s\\/"'\x60<>()[\]]+`;
const SLASH = String.raw`[\\/]`;
/** Not inside a word, a relative path or a link: `src/home/x` and `example.com/home/x` stay. */
const START = String.raw`(?<![\w.~-])`;
/** A folder holding the daemon's `.orchestrator` folder: a home, `~`, or any absolute path. */
const DAEMON_FOLDER = `(?:~|${START}(?:[A-Za-z]:)?(?:${SLASH}${SEGMENT})*)${SLASH}\\.orchestrator${SLASH}`;

const LOCAL_PATHS: [RegExp, string | ((match: string) => string)][] = [
  // A path in a run's worktree becomes relative to it; the worktree itself, `.`.
  [
    new RegExp(`${DAEMON_FOLDER}worktrees${SLASH}${SEGMENT}(?:${SLASH}|(?!${SEGMENT}))`, 'g'),
    (match) => (/[\\/]$/.test(match) ? '' : '.'),
  ],
  [new RegExp(DAEMON_FOLDER, 'g'), '~/.orchestrator/'],
];

/**
 * Local paths made harmless in a text that leaves for GitHub (04, section 3.1; owner's answer
 * 4b, lot 3 step H3), never in the Orchestrator's own screens: a path in a run's worktree becomes
 * relative, the daemon's folder `~/.orchestrator/`. Any other path stays as written: `/home/x`
 * may be a page address, or the absolute path a review reports (answer 4b, narrowed on
 * 2026-10-10).
 */
export function withoutLocalPaths(text: string): string {
  return LOCAL_PATHS.reduce(
    // A function and a string both: TypeScript cannot pick an overload for the union.
    (result, [pattern, replacement]) =>
      typeof replacement === 'string'
        ? result.replace(pattern, replacement)
        : result.replace(pattern, replacement),
    text,
  );
}

/**
 * A text GitHub shows as written and acts on in no way (04, section 3.1): secrets masked, `&`,
 * `<` and `>` escaped (everywhere, code spans included: owner's answer 4, lot 3 step F3), and a
 * zero-width space after `@` before a name, after `#` or `GH-` (any case) before digits, and
 * after `/issues/` before digits, so no mention notifies anyone and no reference or closing
 * keyword ("fixes #3", "fixes owner/repo#3", "fixes GH-3", an issue's link) acts.
 */
export function harmless(text: string): string {
  return withoutLocalPaths(maskSecrets(text))
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/@(?=[A-Za-z0-9_-])/g, `@${ZERO_WIDTH_SPACE}`)
    .replace(/#(?=\d)/g, `#${ZERO_WIDTH_SPACE}`)
    .replace(/(GH-)(?=\d)/gi, `$1${ZERO_WIDTH_SPACE}`)
    .replace(/(\/issues\/)(?=\d)/gi, `$1${ZERO_WIDTH_SPACE}`);
}

/** The first `length` UTF-16 units of `text`, never splitting a character in two. */
function head(text: string, length: number): string {
  if (length <= 0) return '';
  const code = text.charCodeAt(length - 1);
  const cut = code >= 0xd800 && code <= 0xdbff ? length - 1 : length;
  return text.slice(0, cut);
}

/** `text` within `length`, its end replaced by `marker` when it is longer. */
function cutTo(text: string, length: number, marker: string): string {
  if (text.length <= length) return text;
  if (length < marker.length) return '';
  return head(text, length - marker.length).trimEnd() + marker;
}

/** `<number>: <title>`, at most `PULL_REQUEST_TITLE_MAX_LENGTH` characters. */
export function pullRequestTitle(
  template: Template,
  ticket: { number: string; title: string },
): string {
  const title = part(template, 'title', {
    number: harmless(ticket.number),
    title: harmless(ticket.title),
  });
  return cutTo(title, PULL_REQUEST_TITLE_MAX_LENGTH, '…');
}

/** The ticket page's link (`PUBLIC_URL/projects/<key>/tickets/<number>`), and if it is local. */
export function ticketLink(
  publicUrl: string,
  projectKey: string,
  number: number,
): { url: string; loopback: boolean } {
  const base = new URL(publicUrl);
  const url = new URL(
    `projects/${encodeURIComponent(projectKey)}/tickets/${String(number)}`,
    base.href.endsWith('/') ? base.href : `${base.href}/`,
  ).href;
  return { url, loopback: isLoopback(base.hostname) };
}

export interface PullRequestBodyInput {
  /** `WEB-12`. */
  number: string;
  /** The ticket's acceptance criteria, by index. */
  criteria: readonly string[];
  report: StoredDodReport;
  workflowChanges: boolean;
  link: { url: string; loopback: boolean };
}

/**
 * The description: the report's summary, criteria, tests, documentation and ADRs, the workflow
 * warning and the ticket's link. Within `PULL_REQUEST_BODY_MAX_LENGTH`: the sections are cut,
 * the longest first, each with a marker; the warning and the link are always kept.
 */
export function pullRequestBody(
  template: Template,
  input: PullRequestBodyInput,
  maxLength = PULL_REQUEST_BODY_MAX_LENGTH,
): string {
  const { report } = input;
  const files = (submitted: { paths: string[]; justification: string | null }) =>
    submitted.paths.length > 0
      ? submitted.paths.map((path) => part(template, 'path', { path: harmless(path) })).join('\n')
      : part(template, 'justification', { justification: harmless(submitted.justification ?? '') });
  const sections = {
    summary: harmless(report.summary),
    criteria: [...report.criteria]
      .sort((a, b) => a.index - b.index)
      .map((criterion) =>
        part(template, 'criterion', {
          text: harmless(input.criteria[criterion.index] ?? ''),
          justification: harmless(criterion.justification),
        }),
      )
      .join('\n'),
    tests: files(report.tests),
    docs: files(report.docs),
    adrs:
      report.adrs.length > 0
        ? report.adrs.map((path) => part(template, 'path', { path: harmless(path) })).join('\n')
        : part(template, 'no-adrs'),
  };
  const kept = {
    workflow: input.workflowChanges ? part(template, 'workflow') : '',
    link: part(template, input.link.loopback ? 'link-loopback' : 'link', {
      number: harmless(input.number),
      url: input.link.url,
    }),
  };
  const marker = `\n\n${part(template, 'cut')}`;
  const body = (cap: number) => {
    const cut = Object.fromEntries(
      Object.entries(sections).map(([name, text]) => [name, cutTo(text, cap, marker)]),
    );
    return fill(template, template.main, { ...cut, ...kept });
  };
  const whole = body(Number.POSITIVE_INFINITY);
  if (whole.length <= maxLength) return whole;
  // The largest length every section is cut to that fits: only the longest ones are cut.
  let low = 0;
  let high = maxLength;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (body(middle).length <= maxLength) low = middle;
    else high = middle - 1;
  }
  return body(low);
}

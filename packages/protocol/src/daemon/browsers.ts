/**
 * The Playwright version whose Chromium `orchestrator-daemon browsers` downloads and `doctor`
 * checks (05, sections 2 and 8; owner's answer 5, lot 5 step A). Raised with its revision: a
 * daemon test compares the revision with that version's own `browsers.json`.
 */
export const PLAYWRIGHT_VERSION = '1.64.1';
/** The revision of that version's headless Chromium (`chromium_headless_shell-<revision>`). */
export const PLAYWRIGHT_CHROMIUM_REVISION = '1248';

/** The capability a machine detects when its Chromium starts headless (01, section 3.8). */
export const BROWSER_TESTS_CAPABILITY = 'browser-tests';

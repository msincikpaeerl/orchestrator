import { mkdirSync, rmSync } from 'node:fs';
import { SCREENSHOTS } from './fixtures';

/** Empties the owner's screenshots folder before each run, so no picture of an older run stays. */
export default function emptyScreenshots() {
  rmSync(SCREENSHOTS, { recursive: true, force: true });
  mkdirSync(SCREENSHOTS, { recursive: true });
}

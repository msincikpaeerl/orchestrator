# A real GitHub Actions job log, rebuilt

`docs-links.txt` is the log of the skeleton's `docs-links` job failing on a broken documentation link, from the owner's run of the GitHub smoke script on 2026-10-06 (lot 3, after step E2), as GitHub's job page gives it ("View raw logs"). The parser of `apps/server/src/github/job-log.ts` is tested on it. It is a `.txt` file because the repository ignores `*.log` files (`.gitignore`): named `.log`, it was left out of the commit and CI could not find it.

It is **rebuilt, not GitHub's exact bytes**. It came through a paste, which:

- dropped the escape character (`\x1b`) in front of each terminal colour code (`[33m`): it was put back in front of every `[<digits>m`, 16 of them on 4 lines;
- cannot show whether the file starts with a byte order mark: the fixture has none; the tests read it with and without one.

Changed so that nothing of the owner's account is committed: the account and repository (`octo-owner/smoke-test`), the runner's `Worker ID` and the name of the temporary credentials file (zeros). Both tokens were already masked by GitHub (`***`). Everything else is as GitHub wrote it: 191 lines, the timestamps, the markers and the post steps after the failure.

The smoke script's A13 check prints, on the real log, whether it starts with a byte order mark and how many escape characters it holds: the owner's run after step E3 confirms what the paste could not show.

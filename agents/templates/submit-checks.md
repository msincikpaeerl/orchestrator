The submission is refused: {{count}} checks failed. Fix them and submit again.
<!-- part: refused-one -->
The submission is refused: 1 check failed. Fix it and submit again.
<!-- part: refused-push -->
The submission is refused: your branch could not be pushed to GitHub. This is not yours to fix, and nothing you do in this run can fix it: end your turn now, without calling another tool. Your work stays committed on this machine, and the Orchestrator tells the owner what happened.
<!-- part: criteria-out-of-range -->
The ticket has {{count}} acceptance criteria (indexes 0 to {{last}}): {{indexes}} do not exist.
<!-- part: criteria-out-of-range-field -->
no criterion {{index}}
<!-- part: criterion-missing -->
Criterion {{index}} is not reported: "{{text}}".
<!-- part: criterion-not-met -->
Criterion {{index}} is reported not_met: "{{text}}". Meet it, or use ticket_ask to get a decision.
<!-- part: worktree-dirty -->
The worktree has uncommitted changes or untracked files: commit your work first.
<!-- part: no-commits -->
The branch {{branch}} has no commits ahead of the base branch {{base}}: commit your work on it.
<!-- part: same-commit-failed -->
Commit {{commit}} is the one CI failed for in this run: commit your fix on the branch {{branch}}, then submit again.
<!-- part: same-commit-conflict -->
Commit {{commit}} is the one whose pull request conflicts with {{base}}: run `git merge origin/{{base}}`, resolve the conflicts, commit the merge, then submit again.
<!-- part: push-diverged -->
GitHub's copy of the branch {{branch}} has commits this machine does not have, so your commits could not be pushed.
<!-- part: push-refused -->
GitHub refused the push of the branch {{branch}}.
<!-- part: push-unreachable -->
GitHub could not be reached to push the branch {{branch}}.
<!-- part: push-missing -->
The branch {{branch}} was not pushed to GitHub by this machine.
<!-- part: type-docs -->
A docs ticket's deliverable is its documentation: list at least one documentation file this branch changed in docs.paths, wherever it is (a README.md counts). A justification does not replace it.
<!-- part: type-spike -->
A spike records its findings as an ADR or a document: list at least one file this branch changed in adrs or in docs.paths. A justification does not replace it.
<!-- part: path-outside -->
{{field}}: "{{path}}" is outside the repository. List file paths relative to the root of your worktree, such as docs/user/contact.md.
<!-- part: path-folder -->
{{field}}: "{{path}}" is a folder. List the files themselves: a folder is not accepted.
<!-- part: path-not-changed -->
{{field}}: "{{path}}" is not a file this branch changed (compared with origin/{{base}}). List only files you changed and committed, each by its path: a folder is not accepted.
<!-- part: paths-cut -->
Could not be fully done: this machine listed {{listed}} of the {{count}} files the branch changed, so {{unchecked}} listed paths could not be compared.
<!-- part: paths-unknown -->
Could not be done: this machine did not send the files the branch changed.

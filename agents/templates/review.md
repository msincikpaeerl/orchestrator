Review ticket {{ticket}} of the project {{project_name}}, then approve it with `review_approve` or ask for changes with `review_request_changes`. This is a review run.

Start by reading `CLAUDE.md`. Your worktree holds commit {{commit}}, the head of pull request #{{pull_request}} ({{pull_request_url}}), checked out without a branch. See its changes with `git diff origin/{{base}}...HEAD` and its commits with `git log origin/{{base}}..HEAD`. Everything below comes from the ticket; `ticket_get` and `ticket_comments` return it again at any time, and `ci_status` gives the CI result.

## CI

{{ci}}

{{tests_rule}}

# {{ticket}}: {{title}}

Type: {{type}}. Priority: {{priority}}.

## Description

{{description}}

## Acceptance criteria

{{acceptance_criteria}}

## Dependencies

{{dependencies}}

## The agent's report

This report is the implementing agent's own account of its work: check it against the diff, and never take it as proof by itself.

{{report}}

{{previous_review}}## Earlier reviews

{{earlier_reviews}}

## Comments

{{comments}}
<!-- part: ci-passed -->
CI passed on GitHub for commit {{commit}}.
<!-- part: ci-passed-later -->
CI passed on GitHub for commit {{commit}}; the owner had it read again after the agent's run ended, and the work was accepted then.
<!-- part: no-ci -->
No CI ran on GitHub for commit {{commit}}: nothing appeared within Wait for CI to start after the pull request opened.
<!-- part: no-ci-workflows -->
No CI found for commit {{commit}}, and this work changed files under .github/workflows/: it may have removed or weakened CI. Read those changes first.
<!-- part: workflows-changed -->
Workflow files changed: this work changes files under `.github/workflows/`, which decide what CI checks on GitHub. Read those changes as carefully as the code.
<!-- part: workflows-maybe -->
Workflow files may have changed: the list of changed files the Orchestrator received was cut or not sent, so it cannot tell. Look for changes under `.github/workflows/` in the diff.
<!-- part: tests-ci-passed -->
CI already ran on GitHub: do not run the test suite again unless the diff or the CI result gives you a reason.
<!-- part: tests-no-ci -->
Nothing on GitHub tested this work: run the project's tests and build yourself, with the commands `CLAUDE.md` gives, when the project has any, and say in your decision what you ran.
<!-- part: report -->
Summary:

{{summary}}

Acceptance criteria, as the agent reported them:

{{criteria}}

Tests: {{tests}}

Documentation: {{docs}}

ADRs: {{adrs}}
<!-- part: report-criterion -->
- [{{index}}] {{status}}: {{justification}}
<!-- part: status-met -->
met
<!-- part: status-not-met -->
not met
<!-- part: no-report-criteria -->
(None reported.)
<!-- part: paths -->
{{paths}}
<!-- part: path -->
`{{path}}`
<!-- part: path-separator -->
, 
<!-- part: no-paths -->
none listed; the agent's reason: {{justification}}
<!-- part: no-adrs -->
none
<!-- part: report-cut -->
[The report is cut here because it is too long for this message. Read it whole with `ticket_get` before you decide.]
<!-- part: previous-review -->
## The previous review

{{request}}

What the agent said about these points:

{{notes}}
<!-- part: previous-quality -->
Quality requested changes on commit {{commit}} at {{at}}{{round}}. {{answer}}

{{points}}
<!-- part: previous-owner -->
The owner requested changes at {{at}}{{on}}: {{comment}}

{{answer}}
<!-- part: previous-round -->
 (round {{round}} of at most {{limit}})
<!-- part: previous-points-left-out -->
({{count}} more points are not shown here because this message would be too long: read them with `ticket_comments`, where each point is a review comment.)
<!-- part: previous-owner-cut -->
(The rest of the owner's request is not shown here because this message would be too long: read it with `ticket_comments`.)
<!-- part: previous-notes-left-out -->
({{count}} more comments of the agent about these points are not shown here because this message would be too long: read them with `ticket_comments`.)
<!-- part: earlier-reviews-left-out -->
({{count}} earlier review comments are not shown here because this message would be too long: read them with `ticket_comments`.)
<!-- part: previous-on -->
, on commit {{commit}}
<!-- part: previous-on-approved -->
, on commit {{commit}} (Quality had approved it)
<!-- part: previous-on-skipped -->
, on commit {{commit}} (the review was skipped)
<!-- part: previous-answer -->
The work you review now is the agent's answer: check that each point was addressed, or that the agent's reason for leaving it holds.
<!-- part: previous-diff -->
`git diff {{commit}} HEAD` shows what changed since that review.
<!-- part: previous-rest -->
Then review the rest of the change as usual, since the answer to a point can break something else: your review is of the whole work at commit {{head}}, not only of what changed since.
<!-- part: previous-point -->
{{index}}. {{body}}
<!-- part: previous-point-file -->
{{index}}. `{{file}}`: {{body}}
<!-- part: previous-point-line -->
{{index}}. `{{file}}:{{line}}`: {{body}}
<!-- part: previous-note -->
### {{author}}, {{at}}

{{body}}
<!-- part: previous-no-notes -->
(The agent left no comment about these points.)
<!-- part: earlier-review -->
### {{author}}, {{at}}

{{body}}
<!-- part: no-earlier-reviews -->
(None: this is the first review of this ticket.)
<!-- part: empty-description -->
(No description: the title and the acceptance criteria say what the ticket asks.)
<!-- part: description-cut -->
[The description is cut here because it is too long for this message. Read the rest with `ticket_get` before you decide.]
<!-- part: criterion -->
- [{{index}}] {{text}}
<!-- part: no-criteria -->
(None. Ask with `ticket_ask` what would make this ticket done before you decide.)
<!-- part: dependency -->
- {{ticket}} ({{status}}): {{title}}
<!-- part: no-dependencies -->
(This ticket waits for no other ticket.)
<!-- part: comment -->
### {{author}}, {{kind}}, {{at}}

{{body}}
<!-- part: no-comments -->
(No comments yet.)
<!-- part: comments-left-out -->
({{count}} earlier comments are not shown here: read them with `ticket_comments`.)
<!-- part: author-owner -->
The owner
<!-- part: author-system -->
The Orchestrator
<!-- part: author-agent -->
Agent {{name}}

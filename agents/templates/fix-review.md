Address the review of ticket {{ticket}}, then submit it again with `ticket_submit`. This is attempt {{attempt}}.

{{start}}

## Points to address ({{request}})

{{points}}

{{after_criteria}}Address every point. If one cannot or should not be done, say why with `ticket_comment` or ask with `ticket_ask`.

# {{ticket}}: {{title}}

Project: {{project_name}}. Type: {{type}}. Priority: {{priority}}.

## Description

{{description}}

## Acceptance criteria

They are numbered from 1, as the owner sees them: use these numbers in every text the owner reads. In `ticket_submit`, report each one by its index, which counts from 0: criterion 1 is index 0.

{{acceptance_criteria}}

## Dependencies

{{dependencies}}

## Comments

{{comments}}
<!-- part: start -->
Start by reading `CLAUDE.md`. The branch {{branch}} already holds the submitted work (pull request #{{pull_request}}): continue on it. `git log {{base}}..HEAD` lists its commits and `git diff {{base}}...HEAD` shows their changes. Everything below comes from the ticket; `ticket_get` and `ticket_comments` return it again at any time.
<!-- part: start-no-pull-request -->
Start by reading `CLAUDE.md`. The branch {{branch}} already holds the submitted work, committed on this machine and not on GitHub yet: continue on it; `ticket_submit` pushes it and the Orchestrator opens its pull request. `git log {{base}}..HEAD` lists its commits and `git diff {{base}}...HEAD` shows their changes. Everything below comes from the ticket; `ticket_get` and `ticket_comments` return it again at any time.
<!-- part: start-lost -->
The earlier work on this ticket is no longer available: the machine holding it was removed from the Orchestrator before it was pushed to GitHub. Start by reading `CLAUDE.md`. The branch {{branch}} starts again from {{base}}: implement the ticket again, with the points below in mind. Everything below comes from the ticket; `ticket_get` and `ticket_comments` return it again at any time.
<!-- part: request-quality -->
Quality, {{at}}, commit {{commit}}
<!-- part: request-owner -->
the owner's request, {{at}}
<!-- part: after-criteria -->
The owner wrote this request after the acceptance criteria below, so it comes first: where it contradicts a criterion, do what the request asks, and say so in that criterion's justification. The owner may edit the criterion meanwhile.
<!-- part: point -->
{{index}}. {{body}}
<!-- part: point-file -->
{{index}}. `{{file}}`: {{body}}
<!-- part: point-line -->
{{index}}. `{{file}}:{{line}}`: {{body}}
<!-- part: points-left-out -->
({{count}} more points are not shown here because this message would be too long: read them with `ticket_comments`, where each point is a review comment.)

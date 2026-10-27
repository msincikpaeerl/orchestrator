This run has ended (it was stopped, or its time is over): its token is no longer valid. Stop working: nothing you do now will be recorded.
<!-- part: input-invalid -->
The input of {{tool}} is not valid: {{issues}}
<!-- part: input-issue -->
{{field}}: {{message}}
<!-- part: role -->
Your role ({{role}}) does not allow {{tool}}.
<!-- part: ticket-unknown -->
No ticket {{reference}} in the project {{project}}: use ticket_list to find tickets.
<!-- part: profile-unknown -->
No agent profile {{key}}: use agent_list.
<!-- part: profile-unknown-field -->
unknown agent profile
<!-- part: cursor-unknown -->
cursor: pass back a next_cursor returned by this tool.
<!-- part: cursor-unknown-field -->
unknown cursor
<!-- part: description-cut -->
The rest of the description cannot be read through the tools; ask the owner with ticket_ask if you need it.
<!-- part: comment-cut -->
The rest of this comment cannot be read through the tools; ask the owner with ticket_ask if you need it.
<!-- part: too-long -->
Too long: {{details}}.
<!-- part: too-long-characters -->
{{field}}: at most {{max}} characters (setting "{{setting}}": {{max}})
<!-- part: too-long-criteria -->
{{field}}: at most {{max}} criteria (setting "{{setting}}": {{max}})
<!-- part: already-submitted -->
You already submitted this ticket: end your turn now.
<!-- part: already-gave-up -->
You already gave up this ticket: end your turn now.
<!-- part: waiting-answer -->
You asked the owner a question and the ticket waits for the answer: {{tool}} is not possible now. End your turn; the answer arrives as your next message.
<!-- part: needs-in-progress -->
The ticket is {{status}}: {{tool}} needs it in_progress.
<!-- part: review-only -->
{{tool}} is only for a review run of a ticket in in_review; the purpose of this run is {{purpose}}.
<!-- part: already-approved -->
You already approved this ticket in this run: end your turn.
<!-- part: already-requested-changes -->
You already asked for changes on this ticket in this run: end your turn.
<!-- part: already-gave-up-review -->
You already gave up this review: end your turn now.
<!-- part: needs-in-review -->
The ticket is {{status}}: {{tool}} needs it in_review.
<!-- part: reviewer-implemented -->
{{name}} implemented this ticket in an earlier run, so it cannot review it: end your turn without a decision.
<!-- part: review-head-moved -->
The pull request changed on GitHub during your review, now {{head}}: your review of {{commit}} no longer applies. End your turn.
<!-- part: decision-approved -->
Your approval of commit {{commit}} is recorded.
<!-- part: decision-changes-one -->
Your request for changes on commit {{commit}} (1 point) is recorded.
<!-- part: decision-changes -->
Your request for changes on commit {{commit}} ({{count}} points) is recorded.
<!-- part: decision-applied -->
It is applied when your turn ends: end your turn now, without another tool call.
<!-- part: decision-head-unchecked -->
GitHub could not be read to check the pull request's head ({{why}}): the owner is told to check it before merging.
<!-- part: project-archived -->
The project is archived: no ticket can be created in it.
<!-- part: project-not-ready -->
The repository setup of the project is not finished: no ticket can be created yet.
<!-- part: ticket-limit -->
Limit of {{limit}} tickets per run reached (setting "{{setting}}": {{limit}}). Record what you found with ticket_comment instead.
<!-- part: ticket-limit-field -->
at most {{limit}} tickets per run
<!-- part: assignee-reviewer -->
{{name}} reviews the work of other agents and cannot be assigned a ticket: choose a builder or a writer from agent_list, or leave the assignee out.
<!-- part: assignee-reviewer-field -->
this profile cannot be assigned a ticket
<!-- part: blocked-by-unknown -->
No ticket {{references}} in the project {{project}}: blocked_by names tickets of the same project.
<!-- part: blocked-by-unknown-field -->
unknown ticket {{reference}}
<!-- part: plan-ticket-needed -->
Your run plans request {{request}} and has no ticket of its own: name a ticket with `ticket`, or read the request with request_get.
<!-- part: plan-ticket-needed-field -->
a planning run has no ticket: name one
<!-- part: plan-no-ticket -->
Your run plans request {{request}} and has no ticket: {{tool}} is not possible in it. Read the request with request_get, and ask the owner with request_ask.
<!-- part: plan-no-pull-request -->
Your run plans request {{request}}: it has no ticket and no pull request, so ci_status has nothing to report.
<!-- part: plan-decided -->
You already ended the work of this planning run with a decision: end your turn now.
<!-- part: request-only -->
{{tool}} is only for a planning run, which plans a request; the purpose of this run is {{purpose}}.
<!-- part: request-waiting-answer -->
You asked the owner a question and request {{request}} waits for the answer: {{tool}} is not possible now. End your turn; the answer arrives as your next message.
<!-- part: request-not-planning -->
Request {{request}} is {{status}}: request_ask needs it planning. End your turn.
<!-- part: request-text-cut -->
The rest of the request cannot be read through the tools; ask the owner with request_ask if you need it.
<!-- part: request-comment-cut -->
The rest of this comment cannot be read through the tools; ask the owner with request_ask if you need it.

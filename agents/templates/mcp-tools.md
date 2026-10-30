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
<!-- part: project-archived-update -->
The project is archived: its tickets cannot be changed.
<!-- part: ticket-not-editable -->
{{ticket}} is {{status}}: ticket_update changes only a ticket that is proposed or todo. Leave it as it is, and say in your plan's summary what should change.
<!-- part: dependency-itself -->
{{ticket}} cannot wait for itself: remove it from blocked_by.
<!-- part: dependency-itself-field -->
a ticket cannot wait for itself
<!-- part: dependency-cycle -->
These dependencies would make {{ticket}} wait for itself: {{cycle}} (each waits for the next). Remove one of them from blocked_by.
<!-- part: dependency-cycle-field -->
closes the cycle {{cycle}}
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
Request {{request}} is {{status}}: {{tool}} needs it planning. End your turn.
<!-- part: request-text-cut -->
The rest of the request cannot be read through the tools; ask the owner with request_ask if you need it.
<!-- part: request-comment-cut -->
The rest of this comment cannot be read through the tools; ask the owner with request_ask if you need it.
<!-- part: plan-no-project -->
Request {{request}} asks for a new project: there is no project yet, so {{tool}} has nothing to work on. Plan it with plan_propose and new_project.
<!-- part: plan-project-archived -->
The project {{project}} is archived: no plan can be proposed for it. End your run with ticket_give_up, saying so.
<!-- part: plan-refused -->
Your plan is not recorded. Fix every problem below, then call plan_propose again with the whole plan:
{{problems}}
<!-- part: plan-problem -->
- {{place}}: {{message}}
<!-- part: plan-place-ticket -->
Ticket {{position}} ({{key}}), {{field}}
<!-- part: plan-place-whole -->
The plan
<!-- part: plan-too-many -->
{{count}} tickets: at most {{max}} per plan (setting "Most tickets per plan"). Plan the first part of the work now, and say in the summary what a later request should add
<!-- part: plan-duplicate-key -->
the key "{{key}}" is already the key of ticket {{earlier}}: give each ticket its own key
<!-- part: plan-too-long -->
too long: {{length}} characters, at most {{max}} (setting "{{setting}}")
<!-- part: plan-too-many-criteria -->
{{count}} criteria: at most {{max}} (setting "Most acceptance criteria")
<!-- part: plan-criterion-too-long -->
criterion {{number}} is too long: {{length}} characters, at most {{max}} (setting "Longest acceptance criterion")
<!-- part: plan-assignee -->
{{refusal}}. Choose one of {{assignable}}, or leave the assignee out
<!-- part: plan-blocks-itself -->
"{{item}}" is this ticket's own key: a ticket cannot wait for itself
<!-- part: plan-unknown-key -->
no ticket of your plan has the key "{{item}}"
<!-- part: plan-other-project -->
{{item}} belongs to another project: name keys of your plan, or tickets of {{project}}
<!-- part: plan-unknown-ticket -->
there is no ticket {{item}} in the project: use ticket_list to find its tickets
<!-- part: plan-no-project-ticket -->
{{item}} is a ticket number, but the request asks for a new project, which has no tickets yet: name keys of your plan
<!-- part: plan-not-a-reference -->
"{{item}}" is neither a key of your plan nor a ticket number such as {{project}}-3
<!-- part: plan-not-a-key -->
"{{item}}" is not a key of your plan: keys are 1 to 40 lowercase letters, digits, "-" or "_"
<!-- part: plan-cycle -->
these tickets wait for each other, so none of them could ever start: {{cycle}}. Remove one of these dependencies
<!-- part: plan-new-project-unwanted -->
request {{request}} is for the project {{project}}: leave new_project out
<!-- part: plan-new-project-missing -->
request {{request}} asks for a new project: give new_project, with its name, kind and description
<!-- part: plan-android -->
Android projects come with version 0.8.0: choose website or web_app. If the request needs an Android app, end your run with ticket_give_up, saying so
<!-- part: plan-bootstrap-unwanted -->
the project {{project}} already exists: only a plan for a new project has a bootstrap ticket. Remove bootstrap
<!-- part: plan-bootstrap-missing -->
a plan for a new project needs exactly one ticket with bootstrap true: a chore assigned to architect and blocked by nothing, which sets the project up
<!-- part: plan-bootstrap-several -->
{{count}} tickets have bootstrap true ({{keys}}): exactly one may have it
<!-- part: plan-bootstrap-type -->
the bootstrap ticket must be a chore, not a {{type}}
<!-- part: plan-bootstrap-assignee -->
the bootstrap ticket must be assigned to architect
<!-- part: plan-bootstrap-blocked -->
the bootstrap ticket waits for nothing: remove its blocked_by (every other ticket waits for it)
<!-- part: plan-bootstrap-criteria -->
{{count}} criteria once the {{added}} fixed ones the Orchestrator adds are counted: at most {{max}} (setting "Most acceptance criteria"). Keep at most {{own}} criteria of your own besides the fixed ones
<!-- part: plan-bootstrap-settings -->
the setting "{{setting}}" ({{value}}) is too low for the fixed criteria of the bootstrap ticket, which need {{needed}}. Only the owner can raise it: end your run with ticket_give_up, saying so
<!-- part: plan-accepted -->
Your plan for request {{request}} is recorded, with {{count}} tickets, and waits for the owner's review. End your turn now, without another tool call.
<!-- part: plan-accepted-bootstrap -->
The bootstrap ticket {{key}} is first: it received {{added}} fixed criteria, and every other ticket waits for it.

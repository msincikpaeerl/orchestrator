Plan request {{request}} {{for}}, then propose your plan with `plan_propose`. This is attempt {{attempt}} at this request.

Everything below comes from the request and the project; `request_get`, `project_get` and `ticket_list` return it again at any time.

# Request {{request}}

{{body}}

## Conversation

{{comments}}

## The project

{{project}}

## Agents you can assign

{{agents}}

## Limits

A plan holds at most {{max_tickets}} tickets (Most tickets per plan).{{rejection}}
<!-- part: for-project -->
for the project {{project_name}} ({{key}})
<!-- part: for-new-project -->
for a new project
<!-- part: project -->
{{project_name}} ({{key}}), a project of kind `{{kind}}`. Your folder holds its base branch, `{{base}}`, as it is on GitHub.

Its tickets, open ones first:

{{tickets}}
<!-- part: new-project -->
There is no project yet: the request asks for a new one, which your plan proposes with `new_project`. Your folder is empty.
<!-- part: ticket -->
- {{ticket}} ({{status}}, {{type}}, {{assignee}}): {{title}}
<!-- part: no-assignee -->
no assignee
<!-- part: no-tickets -->
(The project has no tickets yet.)
<!-- part: tickets-left-out -->
({{count}} more tickets are not shown here: read them with `ticket_list`.)
<!-- part: agent -->
- `{{key}}`, {{name}}: {{description}}
<!-- part: body-cut -->
[The request is cut here because it is too long for this message. Read the rest with `request_get` before you plan.]
<!-- part: comment -->
### {{author}}, {{kind}}, {{at}}

{{body}}
<!-- part: no-comments -->
(No comments yet.)
<!-- part: comments-left-out -->
({{count}} earlier comments are not shown here: read them with `request_get`.)
<!-- part: author-owner -->
The owner
<!-- part: author-system -->
The Orchestrator
<!-- part: author-agent -->
Agent {{name}}
<!-- part: rejection -->


## The plan the owner rejected

{{summary}}

Its tickets:

{{tickets}}

## The owner's feedback

The owner wrote this after reviewing the plan above, so it comes first: where they disagree, do what the feedback asks.

{{feedback}}
<!-- part: rejected-ticket -->
- `{{key}}`: {{title}}
<!-- part: rejected-tickets-left-out -->
({{count}} more tickets of that plan are not shown here.)
<!-- part: started-by-scheduler -->
Started by the scheduler: the Orchestrator started this run by itself, not the owner.

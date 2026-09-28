Implement ticket {{ticket}} of the project {{project_name}}, then submit it with `ticket_submit`.

Start by reading `CLAUDE.md`. Everything below comes from the ticket; `ticket_get` and `ticket_comments` return it again at any time.

# {{ticket}}: {{title}}

Type: {{type}}. Priority: {{priority}}.

## Description

{{description}}

## Acceptance criteria

Report each one by its index in `ticket_submit`.

{{acceptance_criteria}}

## Dependencies

{{dependencies}}

## Comments

{{comments}}
<!-- part: empty-description -->
(No description: the title and the acceptance criteria say what to do.)
<!-- part: description-cut -->
[The description is cut here because it is too long for this message. Read the rest with `ticket_get` before you start.]
<!-- part: criterion -->
- [{{index}}] {{text}}
<!-- part: no-criteria -->
(None. Ask with `ticket_ask` what would make this ticket done before you start.)
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

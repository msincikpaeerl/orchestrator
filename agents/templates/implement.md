Implement ticket {{ticket}} of the project {{project_name}}, then submit it with `ticket_submit`. This is attempt {{attempt}} at this ticket.

{{start}}

# {{ticket}}: {{title}}

Type: {{type}}. Priority: {{priority}}.

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
Start by reading `CLAUDE.md`. Everything below comes from the ticket; `ticket_get` and `ticket_comments` return it again at any time.
<!-- part: start-earlier-work -->
The ticket's branch already has commits from an earlier attempt. Start by reading `CLAUDE.md`, then see what was done: `git log {{base}}..HEAD` lists those commits and `git diff {{base}}...HEAD` shows their changes. Continue that work rather than redo it. Everything below comes from the ticket; `ticket_get` and `ticket_comments` return it again at any time.
<!-- part: start-not-pushed -->
The ticket's branch already has commits from an earlier attempt, committed on this machine but not pushed to GitHub: GitHub refused the push or could not be reached, and the owner has been told. Start by reading `CLAUDE.md`, then see what was done: `git log {{base}}..HEAD` lists those commits and `git diff {{base}}...HEAD` shows their changes. Continue that work rather than redo it, then submit it with `ticket_submit`, which pushes it. Everything below comes from the ticket; `ticket_get` and `ticket_comments` return it again at any time.
<!-- part: start-diverged -->
The ticket's branch already has commits from an earlier attempt, committed on this machine but not pushed to GitHub: GitHub's copy of the branch has commits this machine does not have, so the push was refused. Start by reading `CLAUDE.md`, then bring GitHub's commits in before anything else: run `git merge origin/{{branch}}` (the Orchestrator downloaded it before your run started), resolve any conflict with your file tools, then `git add` and `git commit`. Never rebase. Then see what was done: `git log {{base}}..HEAD` lists the branch's commits and `git diff {{base}}...HEAD` shows their changes. Continue that work rather than redo it, then submit it with `ticket_submit`, which pushes it. Everything below comes from the ticket; `ticket_get` and `ticket_comments` return it again at any time.
<!-- part: after-ci-failed -->
The previous attempt ended after CI failed on GitHub more times than its run allows: call ci_status to read that result before you start.
<!-- part: after-ci-failed-unsent -->
CI failed on GitHub for the previous attempt's work, and that attempt ended before it received the result: call ci_status to read it before you start.
<!-- part: after-conflict -->
The pull request conflicts with {{base}}: run `git merge origin/{{base}}` and resolve the conflicts before anything else.
<!-- part: empty-description -->
(No description: the title and the acceptance criteria say what to do.)
<!-- part: description-cut -->
[The description is cut here because it is too long for this message. Read the rest with `ticket_get` before you start.]
<!-- part: criterion -->
- Criterion {{number}} (index {{index}}): {{text}}
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

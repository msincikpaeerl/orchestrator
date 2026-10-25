# Import tickets

Instead of typing tickets one by one, you can import several at once from a file: for example a file Claude writes for you on claude.ai after you describe the work. The file lists the tickets, their acceptance criteria and which ones wait for which.

## Import a file

1. Open **Projects**, then the project. **Import tickets** is next to **New ticket**, once the repository setup is **Ready** (it is not there on an archived project).
2. Paste the text of the file in **Text of the file**, or click **Choose a .json file** and pick the file.
3. Click **Preview**. Nothing is created yet. The dialog lists:
   - each problem to correct, with the ticket it is in (its place in the file and its key) and the field, for example "Ticket 2 “contact”, field assignee: No agent profile with the key writer.";
   - warnings, which do not stop the import (see [Warnings](#warnings));
   - the tickets that will be created, in the file's order, with their type, priority, assignee, number of acceptance criteria and what each one waits for.
4. Correct the problems in the text (or in the file, and choose it again), then click **Preview** again.
5. Once there is no problem, click **Import** (it says how many tickets). Every ticket is created, or none if something changed since the preview: the dialog then lists the problems again.
6. The dialog lists the new tickets with their numbers. Click one to open it, or **Close**.

Imported tickets are yours, as if you had created them with **New ticket**: they are in **To do**, numbered in the order of the file, and the [Activity](activity.md) log shows each one created, then the import with the count and the numbers.

## Warnings

- **Assigned tickets can be started by the scheduler right away. Pause the account first if you do not want that.** A ticket in To do with an assignee and nothing to wait for is started by the scheduler (see [Runs](runs.md)). To review the tickets first, use **Stop new runs** on the Claude account before importing, and **Resume** it afterwards (see [Machines](machines.md)), or leave `assignee` out of the file and assign the tickets later.
- **"<key> is blocked by WEB-3, which is cancelled: it will stay blocked until you remove that dependency."** A cancelled ticket is never done, so a ticket waiting for it never starts (see [A ticket waits for a cancelled ticket](tickets.md#a-ticket-waits-for-a-cancelled-ticket)). Remove that number from `blocked_by` unless you mean to reopen the ticket.

## The file

A full example, for a project whose key is `WEB` and which already has a ticket `WEB-3`:

```json
{
  "format": "orchestrator-tickets/1",
  "tickets": [
    {
      "key": "layout",
      "type": "chore",
      "title": "Page layout with header and footer",
      "description": "Every page shares the same header (logo, menu) and footer (address, opening hours).",
      "acceptance_criteria": [
        "The header and the footer appear on every page",
        "The menu links to every page"
      ],
      "priority": "normal",
      "assignee": "web_dev",
      "blocked_by": ["WEB-3"]
    },
    {
      "key": "contact",
      "type": "feature",
      "title": "Contact form",
      "description": "A form with name, email and message. Sending it emails the message to the shop.",
      "acceptance_criteria": [
        "The form refuses an empty name, an invalid email or an empty message",
        "A sent message reaches the shop's address",
        "The visitor sees a confirmation after sending"
      ],
      "priority": "high",
      "assignee": "web_dev",
      "blocked_by": ["layout"]
    },
    {
      "key": "contact-docs",
      "type": "docs",
      "title": "Explain the contact form in the user guide",
      "blocked_by": ["contact"]
    }
  ]
}
```

The fields, for each ticket:

| Field | Required | What it holds |
|---|---|---|
| `key` | Yes | A short name for the ticket inside this file only: 1 to 40 lowercase letters, digits, `-` or `_`, such as `contact-form`. Each key once. |
| `type` | Yes | `feature`, `bug`, `chore`, `docs` or `spike`. |
| `title` | Yes | As in the ticket form. |
| `description` | No | Markdown, as in the ticket form. |
| `acceptance_criteria` | No | A list of texts, in order. |
| `priority` | No | `low`, `normal` (the default) or `high`. |
| `assignee` | No | The key of an agent that does the work: `architect` or `web_dev` (see [Agents](agents.md)). Without it, the ticket waits for you to choose one. |
| `blocked_by` | No | What the ticket waits for: keys of tickets of the same file (`"layout"`), or numbers of tickets already in the project (`"WEB-3"`). |

The file starts with `"format": "orchestrator-tickets/1"` and has nothing else than `format` and `tickets`. A field the Orchestrator does not know is refused, so a misspelt field is never silently ignored. An empty field can also be written `null`.

The same limits as the ticket form apply, with their current values in Settings > Limits (see [Settings](settings.md)): **Longest ticket title**, **Longest ticket description**, **Most acceptance criteria** and **Longest acceptance criterion**, and at most **Most tickets per plan** tickets in one file (15 by default; a file with more is refused: split it in two). Tickets cannot wait for each other in a loop: the preview names the loop, for example "a → c → b → a".

A very large file can be refused as too large to import at once: split it into smaller files.

## Ask Claude to write the file

Paste this in a conversation on claude.ai, then describe the work:

```text
Write the tickets for the work I describe below as one JSON file for the Orchestrator, in this exact format:

{
  "format": "orchestrator-tickets/1",
  "tickets": [
    { "key": "...", "type": "...", "title": "...", "description": "...",
      "acceptance_criteria": ["..."], "priority": "...", "assignee": "...", "blocked_by": ["..."] }
  ]
}

Rules:
- Use only these fields; key, type and title are required, the others optional.
- key: 1 to 40 lowercase letters, digits, "-" or "_", unique in the file.
- type: feature, bug, chore, docs or spike. priority: low, normal or high.
- acceptance_criteria: short, checkable sentences, in order.
- blocked_by: keys of other tickets of this file, or numbers of tickets that already exist in my project, such as WEB-3.
- Before writing the file, ask me two things: the agent keys you may use as assignee, and the numbers of the existing tickets the new tickets depend on. Never invent an agent key or a ticket number: if I give none, leave assignee or blocked_by out.
- Give the whole file in one code block.
```

Your agent keys are on the **Agents** page (`architect` and `web_dev` in this version), and the existing ticket numbers on the project's board.

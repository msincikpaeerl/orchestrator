# Tickets

A ticket is one piece of work on a project: a feature to add, a bug to fix, a page to write. Each ticket has a number made of the project's key and a count, for example `WEB-12`. Numbers are never reused.

In this version you create and manage tickets yourself. From the next version, agents will pick up tickets and do the work.

## The board

Open **Projects**, then a project: its tickets are on the project page, under **Tickets**, once the repository setup is **Ready**.

- Tickets are grouped by state: **To do**, **In progress**, **Waiting for you**, **In review** and **Awaiting merge**. See [Ticket states](#ticket-states).
- **Done** and **Cancelled** are closed at the bottom. Click one to open it.
- **Proposed** tickets are not shown on the board. They come with plans, in a later version.
- Each card shows the ticket's number, title and type, and **Blocked** when it waits for another ticket (see [Blocked tickets](#blocked-tickets)).
- **Type** shows only tickets of one type. **Search** finds a ticket by its number (`WEB-12` or `12`) or by words of its title.

On a computer the states sit side by side. On a phone they are one below the other: scroll down to see them all.

## Create a ticket

1. Open the project and click **New ticket**.
2. Fill in the form:
   - **Type**: **Feature** (something new), **Bug** (something broken), **Chore** (maintenance), **Documentation**, or **Spike** (a short investigation to answer a question).
   - **Title**: a short sentence, for example "Add a search box to the recipe list".
   - **Description**: what must be done and why. See [Formatting](#formatting-descriptions-and-comments).
   - **Acceptance criteria**: the statements that must be true when the work is done, one per criterion, for example "Typing a word shows only the recipes that contain it". Use **Add a criterion**, and **Move up** or **Move down** to put them in order. Empty criteria are left out.
   - **Priority**: **Low**, **Normal** or **High**. Higher priority tickets come first in their column.
   - **Blocked by**: the tickets that must be done before this one can start (see [Dependencies](#dependencies)). Optional.
3. Click **Create the ticket**. The ticket starts in **To do** and its page opens.

## Edit a ticket

Open the ticket and click **Edit**. You can change the type, title, description, acceptance criteria and priority, then click **Save**.

A ticket can be edited only while it is **To do** (or **Proposed**). Once work has started, it cannot be edited: add a comment instead.

The tickets it waits for are not in this form: change them on the ticket's page (see [Dependencies](#dependencies)).

## Formatting descriptions and comments

Descriptions, acceptance criteria and comments use Markdown: `**bold**`, `*italic*`, lists starting with `-` or `1.`, `` `code` ``, tables, and links such as `[the design](https://example.com/design)`.

For your safety, and because agents also write in tickets:

- HTML is shown as plain text, never used for layout.
- Only links starting with `https://`, `http://` or `mailto:` work. Other links show only their text. Links open in a new tab.
- Images are never shown inside the ticket: each one appears as a link "Image: …" that you can click to open it.

## Dependencies

A dependency says that a ticket waits for another one: work on it starts only once the other ticket is **Done**. On the ticket page, **Dependencies** shows:

- **Blocked by**: the tickets it waits for, with their state;
- **Blocks**: the tickets waiting for it.

To add one, choose a ticket in **Add a ticket it waits for** and click **Add**. To remove one, click **Remove** next to it. The ticket it waits for can be in any state.

The rules:

- Dependencies can be changed only while the waiting ticket is **To do** (or **Proposed**).
- A ticket can only wait for tickets of the same project, and never for itself.
- Tickets cannot wait for each other in a loop, for example `WEB-1` waiting for `WEB-2` while `WEB-2` waits for `WEB-1`: none of them could ever start. The Orchestrator refuses such a dependency and shows the loop, for example "WEB-3 → WEB-1 → WEB-2 → WEB-3". Remove one of the dependencies of the loop first if the order has changed.

## Blocked tickets

A ticket is **Blocked** while at least one ticket it waits for is not **Done**. The board shows a **Blocked** badge, and the ticket page says which tickets it waits for. Being blocked is not a state: the ticket stays in **To do**, and it is unblocked as soon as every ticket it waits for is done. The badge is shown for tickets that have not started (**To do** or **Proposed**).

### A ticket waits for a cancelled ticket

A cancelled ticket is not done, so **a ticket waiting for a cancelled ticket stays blocked**. The ticket page tells you when this happens. You can:

- **remove the dependency**, if the ticket no longer needs the cancelled work: on the waiting ticket's page, click **Remove** next to the cancelled ticket under **Blocked by**; or
- **reopen the cancelled ticket**, if the work is needed after all: open it and click **Reopen**. The waiting ticket is unblocked when it is done.

## Comments

At the bottom of a ticket's page, **Timeline** lists the comments and the changes of state, oldest first. To add a note, write it in **Add a comment** and click **Add comment**. You can comment on any ticket, even a done or cancelled one, except in an archived project.

## Cancel a ticket

Tickets are never deleted: a ticket created by mistake, or whose work is abandoned, is cancelled.

**Cancel or mark as done?** Cancel when the work is abandoned: nobody will do it. Tickets waiting for a cancelled ticket stay blocked. If the result exists because the work was done another way, use [Mark as done manually](#mark-as-done-manually) instead: it unblocks the tickets waiting for it.

1. Open the ticket and click **Cancel the ticket**.
2. Confirm with **Cancel the ticket**, or click **Keep it** to change your mind.

The ticket moves to **Cancelled** with its history. Tickets waiting for it stay blocked (see [A ticket waits for a cancelled ticket](#a-ticket-waits-for-a-cancelled-ticket)). Any ticket that is not done or cancelled can be cancelled.

## Mark as done manually

Use **Mark as done manually** when the result exists but was done another way, for example you fixed it yourself. Tickets waiting for it are then unblocked. If the work is abandoned instead, [cancel the ticket](#cancel-a-ticket): tickets waiting for it stay blocked.

1. Open the ticket and click **Mark as done manually**.
2. Write **why it is done**. This comment is required: without it, the ticket is not marked as done. It is added to the timeline.
3. Click **Mark as done**.

The ticket moves to **Done**, and tickets waiting for it are no longer blocked by it. This is possible from **To do**, **In progress**, **Waiting for you**, **In review** and **Awaiting merge**, but not from **Proposed**: a proposed ticket belongs to a plan that is not approved yet.

## Reopen a cancelled ticket

Open the cancelled ticket and click **Reopen**. It goes back to **To do** with its number, history and dependencies.

## Ticket states

| State | Meaning |
|---|---|
| **Proposed** | Part of a plan not approved yet. Not shown on the board. Plans come in a later version. |
| **To do** | Waiting for work. |
| **In progress** | An agent is working on it. |
| **Waiting for you** | An agent asked you a question. |
| **In review** | The work is on GitHub and being reviewed. |
| **Awaiting merge** | The review approved the work: you merge the pull request on GitHub. |
| **Done** | Finished: merged, or marked as done manually. |
| **Cancelled** | Abandoned. It can be reopened. |

Agents move tickets through **In progress**, **Waiting for you**, **In review** and **Awaiting merge** from the next versions. In this version, your tickets are **To do**, **Done** or **Cancelled**.

## If an action is refused

The page says why in plain words. The most common reasons:

- **A text is too long**: the message names the field and its limit, for example "The title can have at most 200 characters." Shorten it and try again. These limits can be changed in **Settings > Limits** (see [Change a limit](settings.md#change-a-limit)).
- **The ticket changed state**: for example it was already cancelled. The page shows its current state and the actions it allows.
- **The project is archived**: its tickets are read-only. Unarchive the project first (see [Archive a project](projects.md#archive-a-project)).

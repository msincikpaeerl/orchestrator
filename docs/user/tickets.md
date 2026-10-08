# Tickets

A ticket is one piece of work on a project: a feature to add, a bug to fix, a page to write. Each ticket has a number made of the project's key and a count, for example `WEB-12`. Numbers are never reused.

You create tickets, and an agent does the work when you click **Run now** (see [Runs](runs.md)). Agents can also propose new tickets they found while working (see [Tickets proposed by agents](#tickets-proposed-by-agents)).

## The board

Open **Projects**, then a project: its tickets are on the project page, under **Tickets**, once the repository setup is **Ready**.

- Tickets are grouped by state: **To do**, **In progress**, **Waiting for you**, **In review** and **Awaiting merge**. See [Ticket states](#ticket-states).
- **Done** and **Cancelled** are closed at the bottom. Click one to open it.
- **Proposed** shows the tickets agents proposed, while there is at least one (see [Tickets proposed by agents](#tickets-proposed-by-agents)).
- Each card shows the ticket's number, title, type and assignee, **Blocked** when it waits for another ticket (see [Blocked tickets](#blocked-tickets)), **created by agent** for a ticket an agent proposed, and the run in progress with the agent's latest progress line (see [Watch a run](runs.md#watch-a-run)).
- The board updates on its own while you look at it.
- **Type** shows only tickets of one type. **Assignee** shows only the tickets of one agent, or the **Unassigned** ones. **Search** finds a ticket by its number (`WEB-12` or `12`) or by words of its title.

On a computer the states sit side by side. On a phone they are one below the other: scroll down to see them all.

## Create a ticket

1. Open the project and click **New ticket**.
2. Fill in the form:
   - **Type**: **Feature** (something new), **Bug** (something broken), **Chore** (maintenance), **Documentation**, or **Spike** (a short investigation to answer a question).
   - **Title**: a short sentence, for example "Add a search box to the recipe list".
   - **Description**: what must be done and why. See [Formatting](#formatting-descriptions-and-comments).
   - **Acceptance criteria**: the statements that must be true when the work is done, one per criterion, for example "Typing a word shows only the recipes that contain it". Use **Add a criterion**, and **Move up** or **Move down** to put them in order. Empty criteria are left out. Write only what the agent can show in its own work: the agent must report every criterion as met before it can hand its work in. Don't write "the automatic checks pass" as a criterion: the Orchestrator checks that itself after the agent hands its work in.
   - **Priority**: **Low**, **Normal** or **High**. Higher priority tickets come first in their column.
   - **Assignee**: the agent expected to do the work, for example **Web Developer** (see [Assignee](#assignee)). Optional.
   - **Blocked by**: the tickets that must be done before this one can start (see [Dependencies](#dependencies)). Optional.
3. Click **Create the ticket**. The ticket starts in **To do** and its page opens.

## Edit a ticket

Open the ticket and click **Edit**. You can change the type, title, description, acceptance criteria, priority and assignee, then click **Save**.

A ticket can be edited only while it is **To do** (or **Proposed**). Once work has started, it cannot be edited: add a comment instead.

The tickets it waits for are not in this form: change them on the ticket's page (see [Dependencies](#dependencies)).

## Assignee

The assignee is the agent expected to do the work of a ticket: the **Architect** for the project's structure and tools, the **Web Developer** for features and fixes of a web app or website (see [Agents](agents.md)). The ticket page shows it under **Assignee**, and each card of the board shows it too.

Choose it when you create the ticket, or later with **Edit**, while the ticket is **To do** (or **Proposed**). Choose **No assignee** to remove it. Any agent can be assigned to any ticket in this version; the Orchestrator will check that an agent suits the ticket in a later version.

A run starts only on a ticket that has an assignee (see [Start a run](runs.md#start-a-run)).

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

If the ticket still waits for tickets that are not done, the dialog warns you and names them with their states, for example "WEB-4 still waits for WEB-2 (Cancelled) and WEB-3 (To do)". You can still mark it as done: the button becomes **Mark as done anyway**. Do it only if its work no longer needs them; the tickets it waits for do not change.

The ticket moves to **Done**, and tickets waiting for it are no longer blocked by it. This is possible from **To do**, **In progress**, **Waiting for you**, **In review** and **Awaiting merge**, but not from **Proposed**: accept or reject a proposed ticket instead.

## Request changes

Use **Request changes** on a ticket **In review** when the agent's work is not right yet.

1. Open the ticket, or find it in [Needs you](needs-you.md#agents-work), and click **Request changes**.
2. Write **what should change**. This comment is required; it is added to the timeline and the next agent reads it.
3. Click **Request changes**.

The ticket goes back to **To do**. Its branch and commits are kept, and this does not count as a failed attempt. The next dialog offers **Run now** to start the next run at once; click **Later** to start it yourself later. See [Check finished work](runs.md#check-finished-work).

## Reopen a cancelled ticket

Open the cancelled ticket and click **Reopen**. It goes back to **To do** with its number, history and dependencies.

## Tickets proposed by agents

While working, an agent may find more work outside its ticket, for example a bug it noticed. It then proposes a ticket: the ticket is **Proposed**, shows **created by agent** on the board, and its page says which agent created it. An agent can propose only a few tickets per run (**Most tickets an agent creates per run**, 3 by default, in [Settings](settings.md#runs)).

Open the ticket and:

- click **Accept** to keep it: it moves to **To do**, ready for **Run now**. You can **Edit** it before or after accepting it;
- or click **Reject**, write why if you like, and confirm: the ticket is **Cancelled** with its history. You can reopen it later.

## When the work cannot be pushed to GitHub

From version 0.4.0, when an agent submits its work, its machine first pushes the ticket's branch to GitHub. If GitHub refuses the push or cannot be reached, the agent can do nothing about it, so it stops at once:

- the run ends as **failed**, with the reason "its branch could not be pushed to GitHub". It does **not** count as a failed attempt;
- the ticket goes back to **To do**, with a comment saying what happened. The work stays committed on that machine;
- [Needs you](needs-you.md#agents-work) shows what to do, as one of these items:

| Item | Why | What to do |
|---|---|---|
| GitHub refused the push of …: the token needs Contents (Read and write) | The GitHub token is not allowed to write to the repository. | Click **Open your tokens on GitHub**, open the Orchestrator's token, set **Contents** to **Read and write**, and save it. Do not regenerate the token: a new token would have to be entered again in the Orchestrator. Then **Run now**. |
| GitHub refused the push of …: the token needs Workflows (Read and write) | The work changes a GitHub workflow, a file in `.github/workflows/`, and the token is not allowed to. GitHub's own message speaks of a "`workflow` scope": this is the **Workflows** permission of the token page. | Same, with **Workflows** set to **Read and write**. Before you do, keep in mind that a workflow change runs on GitHub before anyone reads it, and could weaken the checks that judge the agent's work. |
| GitHub refused the push of … (other reasons) | GitHub refused for another reason, for example a rule of the repository. The item shows GitHub's own words, with any secret hidden. | Fix the cause on GitHub, then **Run now**. |
| The branch of … changed on GitHub | GitHub's copy of the ticket's branch has commits the machine does not have, for example after **Update branch** on GitHub or a push by hand. The Orchestrator never overwrites GitHub's branch. | **Run now**: the next run, on the same machine, first brings GitHub's commits in with a merge, then continues and pushes. |
| GitHub could not be reached to push … | The machine could not connect to GitHub. | Check that the machine is connected to the internet and that GitHub works, then **Run now**. |

**Run now** starts the next run on the machine that holds the work, and tells the agent that its work is committed but was not pushed. The item disappears as soon as a push of the ticket's branch succeeds, including the push a machine makes when a run ends, or when the ticket is cancelled or marked as done. It stays while the next run works.

## Ticket states

| State | Meaning |
|---|---|
| **Proposed** | Proposed by an agent and waiting for you to accept or reject it. From a later version, also part of a plan not approved yet. |
| **To do** | Waiting for work. |
| **In progress** | An agent is working on it (see [Runs](runs.md)). |
| **Waiting for you** | An agent asked you a question (see [Questions](runs.md#questions)). |
| **In review** | In this version: the agent finished its work, on a branch of your machine, and it waits for you to check it. From a later version: the work is on GitHub and being reviewed. |
| **Awaiting merge** | The review approved the work: you merge the pull request on GitHub. |
| **Done** | Finished: merged, or marked as done manually. |
| **Cancelled** | Abandoned. It can be reopened. |

In this version, agents move tickets through **In progress**, **Waiting for you** and **In review**. When you have checked the work of a ticket **In review**, use [Mark as done manually](#mark-as-done-manually) if it is right, or [Request changes](#request-changes) if it is not. **Awaiting merge** comes with pull requests, in a later version.

## If an action is refused

The page says why in plain words. The most common reasons:

- **A text is too long**: the message names the field and its limit, for example "The title can have at most 200 characters." Shorten it and try again. These limits can be changed in **Settings > Limits** (see [Change a limit](settings.md#change-a-limit)).
- **The ticket changed state**: for example it was already cancelled. The page shows its current state and the actions it allows.
- **The project is archived**: its tickets are read-only. Unarchive the project first (see [Archive a project](projects.md#archive-a-project)).

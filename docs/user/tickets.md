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

## Submission and the pull request

From version 0.4.0, when an agent has finished a ticket, it hands its work in with a report: a summary, each acceptance criterion met or not with why, and the files of tests, documentation and architecture decisions it changed (or why none were needed). Its machine first pushes the ticket's branch to GitHub. The Orchestrator then checks the work, and:

- when the checks pass, it accepts the work and opens the ticket's pull request on GitHub just after (see [The pull request](#the-pull-request)). The run then waits for CI, GitHub's automatic checks of the pull request: when CI passes, the run ends and the ticket moves to **In review** (see [Waiting for CI](#waiting-for-ci));
- when a check fails, it refuses the work and tells the agent why; the agent fixes it and hands it in again, in the same run. Only a branch that could not be pushed to GitHub ends the run at once (see [When the work cannot be pushed to GitHub](#when-the-work-cannot-be-pushed-to-github)).

### The checks

The ticket page shows them under **Agent's report** > **Checks**, for the work accepted. The run page shows them under **Latest refused submission**, for the last work of that run the checks refused: there you see why an agent was refused, also when it is refused again and again.

| Check | What the Orchestrator checks |
|---|---|
| **Acceptance criteria met** | The agent reports every acceptance criterion of the ticket as met. |
| **All work committed** | No change is left uncommitted on the machine. |
| **Commits on the branch** | The ticket's branch has commits of its own, compared with the project's default branch. |
| **Branch pushed to GitHub** | The machine pushed the ticket's branch to GitHub. |
| **Rules of the ticket type** | A **Documentation** ticket lists at least one documentation file its branch changed (a README.md counts). A **Spike** lists at least one architecture decision or document its branch changed. An explanation does not replace them. Other types have no rule of their own. |
| **Listed files changed on the branch** | Every file the agent lists for tests, documentation and architecture decisions is a file its branch changed. A folder is not accepted, nor a path outside the project's files. |

Each check shows one result:

| Result | Meaning |
|---|---|
| **Passed** | The check found nothing wrong. |
| **Failed** | The check found a problem, and the work was refused. The lines below it say why, for example "Documentation listed: “docs/user/contact.md” is not a file the ticket's branch changed." |
| **Could not be fully done** | The machine could not send the whole list of files the branch changed (a very large change, or a daemon older than 0.4.0), so some listed files could not be compared. The lines below say how many. This never refuses the work. |
| **Not checked** | The branch was not pushed because the work was not ready: changes not committed, or no commits. The checks that failed say which. |

Under each check that failed or could not be fully done, **What the agent was told** opens the message the agent received, word for word. It is written for an agent, in the terms an agent works with; the lines above it say the same in plain words. Paths and sentences written by an agent are always shown as plain text, with any secret hidden. A long list shows its first 10 lines; **Show the other …** opens the rest.

Work accepted by version 0.3.0 has no result per check: its page says it was checked by an earlier version.

### The pull request

When the work is accepted, the Orchestrator opens a pull request for the ticket on GitHub, from the ticket's branch into the project's default branch. Its title is the ticket's number and title, and its description holds the agent's summary, the acceptance criteria, the tests, documentation and architecture decisions it lists, a warning when the work may change a GitHub workflow, and a link to the ticket in the Orchestrator. A later accepted submission updates the same pull request; one you closed without merging is reopened. If a pull request of the ticket was already merged, a new one is opened.

Nothing in it can act on GitHub by itself: secrets are hidden, HTML is shown as text, and an invisible space is added after `@`, `#` and `GH-` (and in links to issues), so the text notifies nobody and closes no issue. A ticket title longer than GitHub allows for a pull request is cut, and so is a very long description, with a note saying so. One limit remains: a commit message an agent wrote with "fixes #3" still closes issue 3 when you merge, since the Orchestrator never rewrites the agent's commits.

The ticket page shows it under **Pull request**:

- **Pull request #12 · Open**: the link opens it on GitHub. The state is **Open**, **Closed without merging** or **Merged**. It is the state the Orchestrator saw when it last opened or updated the pull request; the link always shows its current state on GitHub.
- **Opening the pull request on GitHub…**: the work was just accepted, and the pull request is being opened or updated.
- **Pull request not opened**, with the reason, for example "Pull request not opened: GitHub could not be reached": GitHub could not open it. The work itself is safe on GitHub. The page says what to do, then click **Try again**. [Needs you](needs-you.md#pull-request-not-opened) lists the same, with every reason.
- **Pull request not updated**, under an open pull request: a later accepted submission could not update it. The pull request is there, but its description still shows the report of the earlier submission; the new commits are on GitHub, in the pull request. Click **Try again** as above. A pull request closed without merging, or merged, says **Pull request not opened**, since the next try reopens it or opens a new one.

### Waiting for CI

CI is the set of automatic checks GitHub runs on the pull request: the GitHub Actions workflows of the project, and any other service reporting a status on GitHub. While it runs, the run's status reads **Waiting for CI**, and the run page's **CI** card shows each check and its state (see [Runs > Waiting for CI](runs.md#waiting-for-ci)). The agent's session stays open, idle: it uses none of your Claude usage, and its time counts as waiting, not working (so **Longest run** and **Idle timeout** do not apply). The run still counts in its Claude account's **Runs at the same time**, so with the default of 1, another ticket of that account waits for it.

What the Orchestrator reads:

- Only the commit the machine pushed when the agent handed its work in: never an older commit of the branch, even one whose CI passed, nor a commit added to the branch on GitHub afterwards (for example by **Update branch**).
- It asks GitHub every **GitHub check interval** (60 seconds by default, in **Settings > Limits**). The wait starts when the pull request is open; a pull request that was already open counts at once.

What it decides:

| CI result | What happens |
|---|---|
| **Passed**: every workflow run and status finished and passed (a skipped one counts as passed) | The run ends as succeeded, and the ticket moves to **In review**. |
| **No CI found**: nothing appeared within **Wait for CI to start** (5 minutes by default) | The work is accepted as if CI had passed, and the ticket moves to **In review**. A project without workflows always gets this. When the work also changed workflow files, Activity says both in one sentence: the agent may have removed or weakened CI, so read the changes in `.github/workflows/` before merging (see [Workflow files](#workflow-files)). |
| **Conflicts with the default branch**: nothing appeared, and the pull request conflicts with the project's default branch | Never accepted: GitHub runs no CI on a pull request with a conflict, so the work was not tested. In this version the run waits until **CI wait at submission**, then stops as below. |
| **Failed**: a workflow run failed, was cancelled or timed out, or a status failed | In this version the run ends as **failed**, and it counts as a failed attempt. The ticket goes back to **To do** with a comment naming what failed. |
| Still running when **CI wait at submission** (20 minutes by default) is reached | The run ends as **failed**, without counting as a failed attempt. The ticket goes back to **To do** with its branch, its pull request and a comment saying why. |

If GitHub cannot be reached, refuses because of its request limit, or answers something the Orchestrator cannot read, the run keeps waiting and the Orchestrator asks again: only **CI wait at submission** ends the wait. [Activity](activity.md) shows when GitHub could not be checked, and when it could again. A problem with the token shows in [Needs you](needs-you.md) as usual.

If the agent's session stops while it waits (Claude Code closed, or the machine restarted), nothing is lost: CI still decides, and a run whose CI passes ends as succeeded. If the Orchestrator itself restarts, it goes on waiting where it stopped. A result GitHub gave meanwhile counts, even after **CI wait at submission**.

### Workflow files

Workflows are the files of `.github/workflows/`: the automatic checks GitHub runs on the pull request. A workflow runs on GitHub before anyone reads it, and an agent changing one could weaken the checks that judge its own work. So the ticket page warns you under **Pull request**, and the pull request's description says the same:

| Warning | Why | What to do |
|---|---|---|
| **Workflow files changed** | The work changes files in `.github/workflows/`. | Before merging, open the pull request's **Files changed** tab and read the changes in `.github/workflows/` first. |
| **Workflow files may have changed** | The machine could not send the whole list of files the work changed, so a workflow change cannot be ruled out. Work accepted before this warning kept its reason also shows it. | Before merging, look at every changed file on the pull request's **Files changed** tab, `.github/workflows/` first. |

### When the work cannot be pushed to GitHub

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

**Run now** starts the next run on the machine that holds the work, and tells the agent that its work is committed but was not pushed. The item disappears as soon as a push of the ticket's branch succeeds, including the push a machine makes when a run ends, or when the ticket is cancelled or marked as done, or the machine is revoked (its work not on GitHub is then lost, see [Runs](runs.md#where-the-work-is)). It stays while the next run works.

## Ticket states

| State | Meaning |
|---|---|
| **Proposed** | Proposed by an agent and waiting for you to accept or reject it. From a later version, also part of a plan not approved yet. |
| **To do** | Waiting for work. |
| **In progress** | An agent is working on it (see [Runs](runs.md)). |
| **Waiting for you** | An agent asked you a question (see [Questions](runs.md#questions)). |
| **In review** | The agent finished its work and the checks accepted it. From version 0.4.0 the work is on GitHub, with its pull request, and CI passed or found nothing to run (see [Submission and the pull request](#submission-and-the-pull-request)); it waits for you to check it. |
| **Awaiting merge** | The review approved the work: you merge the pull request on GitHub. Not used yet in this version. |
| **Done** | Finished: merged, or marked as done manually. |
| **Cancelled** | Abandoned. It can be reopened. |

In this version, agents move tickets through **In progress**, **Waiting for you** and **In review**. When you have checked the work of a ticket **In review**, on its pull request, use [Mark as done manually](#mark-as-done-manually) if it is right, or [Request changes](#request-changes) if it is not. Nothing moves a ticket to **Awaiting merge** yet.

## If an action is refused

The page says why in plain words. The most common reasons:

- **A text is too long**: the message names the field and its limit, for example "The title can have at most 200 characters." Shorten it and try again. These limits can be changed in **Settings > Limits** (see [Change a limit](settings.md#change-a-limit)).
- **The ticket changed state**: for example it was already cancelled. The page shows its current state and the actions it allows.
- **The project is archived**: its tickets are read-only. Unarchive the project first (see [Archive a project](projects.md#archive-a-project)).

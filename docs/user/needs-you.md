# Needs you

**Needs you** is the home page of the Orchestrator. It lists everything waiting for you; when it is empty, nothing needs you. The number next to "Needs you" in the menu counts the items.

In this version, it shows:

- what agents' work leaves for you: questions, tickets they propose, finished work to check and runs paused by a usage limit (see [Agents' work](#agents-work));
- problems with the GitHub connection, projects whose setup failed, the setup still to do (a Claude account and a machine), machines that cannot work and machines offline while agents were working on them.

Later versions add plans to approve and pull requests to merge.

The setup still to do comes first. Every other item is listed oldest first, by the time its reason began: when the question was asked, the ticket proposed, the work submitted or the run paused.

## Claude accounts

Above the items, one line per Claude account says whether agents can use it:

- **Available**: runs can start on it.
- **Limited until 3:45 PM**: the account reached its Claude usage limit; no run starts on it before that time. "(estimated)" after the time means Claude gave no reset time, so the Orchestrator waits the **Quota wait when the reset time is unknown** (see [Settings](settings.md#settings-reference)). Once the time has passed, the line shows **Available** again by itself.

A limited account is not an item of its own: the runs it paused are listed below, and **Run now** says why it cannot start a run, with the time.

## Agents' work

Each item links to its ticket; its buttons are the same as on the ticket page.

| Item | Why it appears | What to do |
|---|---|---|
| Question from agent … | An agent needs a decision only you can make; the ticket is **Waiting for you**. | Write your answer in **Your answer** and click **Send answer**, as on the ticket page (see [Questions](runs.md#questions)). |
| Ticket proposed by agent … | While working, an agent found more work and proposed a ticket. | **Accept** it (it moves to **To do**) or **Reject** it (see [Tickets proposed by agents](tickets.md#tickets-proposed-by-agents)). |
| Work finished: check it | An agent finished a ticket: it is **In review**. The item shows the agent's summary; **Open the run** shows its log. | If the work is right, **Mark as done manually**. If not, **Request changes** (see [Check finished work](runs.md#check-finished-work)). |
| Run paused: Claude usage limit reached | The run stopped at the usage limit of its Claude account. The item says when you can resume it, "(estimated)" when Claude gave no reset time. | Wait for that time, then click **Resume**: the button becomes available by itself. Or **Stop run**. |
| Run paused: possible Claude usage limit | The run stopped on an error that may be the usage limit, or Claude being overloaded, or a network problem. | Click **Resume** at once: the run may pause again if it was the limit. Or **Stop run**. |

In this version nothing resumes by itself: a paused run waits for your **Resume**. An item disappears once it is handled: answered, accepted or rejected, marked as done or sent back, resumed or stopped.

## GitHub items

Each item has a link to **Settings > GitHub connection**, where you fix it by entering a new token (see [Connect GitHub](github-token.md)).

| Item | Why it appears | What to do |
|---|---|---|
| Your GitHub token expires soon | The expiry date you entered is less than 14 days away (the **GitHub token expiry warning** setting, see [Settings](settings.md#settings-reference)). | Create a new token and enter it with **Replace the token**. |
| Your GitHub token has expired | The expiry date you entered has passed. | Create a new token and enter it. |
| GitHub no longer accepts your token | GitHub refused the token: it was deleted, revoked or has expired. | Create a new token and enter it. |
| The GitHub token is missing a permission | The permissions check found it missing. | Create a new token with the **Create the token on GitHub** button, which fills in every permission, and enter it. |
| GitHub refused a request | The Orchestrator needed a permission the token does not have. | Same as above. |
| Enter your GitHub token again | The secret key in `.env` changed, so the saved token cannot be read. | Enter the token again; see [Back up your secret key](secret-key.md). |

An item disappears once the problem is fixed: after entering a new token, or after **Check again** succeeds.

## Project items

| Item | Why it appears | What to do |
|---|---|---|
| Project setup failed | The Orchestrator could not finish creating or reading the project's GitHub repository. The item names the step that failed and why. | Click **Open the project**, fix the cause if needed, then click **Try again**. See [If the setup fails](projects.md#if-the-setup-fails). |

The item disappears once the setup is ready. An archived project is not listed, even if its setup failed: unarchive it first.

## Setup and machine items

| Item | Why it appears | What to do |
|---|---|---|
| No Claude account yet | No Claude account exists yet. | Click **Open Machines**, then **Add a Claude account**. See [Add a Claude account](machines.md#add-a-claude-account). |
| No machine enrolled yet | No machine has enrolled yet, or every machine is revoked. | Click **Add machine**. See [Add a machine](machines.md#add-a-machine). |
| Update the daemon on … | The machine's daemon is too old (or too new) for this version of the Orchestrator: either it cannot connect, or it connects but gets no runs. | On the machine, type the commands the item shows, one after the other. See [Update the daemon](machines.md#update-the-daemon). |
| The daemon on … is not the one this Orchestrator provides | The daemon works with this Orchestrator, but it is another build than the one this Orchestrator provides, older or newer. The machine still gets runs. | When no agent works on the machine, type the commands the item shows. See [Update the daemon](machines.md#update-the-daemon). |
| Claude Code not supported on … | Claude Code is missing on the machine, or too old: found when the daemon connects, or when a run starts (Claude Code updates itself, so its version can change while the daemon runs). A run that could not start for this reason does not count as a failed attempt. | Install or update Claude Code, then type the restart command the item shows. |
| Problem on … | A check on the machine found an error; the item lists it. | Fix it on the machine, then type the restart command. |
| … is offline with work on it | The machine is offline while agents' runs are on it; the item names their tickets. The runs wait: their Claude Code sessions keep running on the machine if it is still on. | Start the machine, or its daemon, so it connects again. |

Each machine item opens the machine's page. Details: [When a machine has a problem](machines.md#when-a-machine-has-a-problem). The item disappears once the daemon connects again without the problem.

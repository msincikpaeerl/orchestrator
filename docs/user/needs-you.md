# Needs you

**Needs you** is the home page of the Orchestrator. It lists everything waiting for you; when it is empty, nothing needs you. The number next to "Needs you" in the menu counts the items.

In this version, it shows problems with the GitHub connection, projects whose setup failed, the setup still to do (a Claude account and a machine) and machines that cannot work. Later versions add questions from agents, plans to approve and pull requests to merge.

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
| Update the daemon on … | The machine's daemon does not match this version of the Orchestrator. | On the machine, type the two commands the item shows: the install command, then the restart. |
| Claude Code not supported on … | Claude Code is missing on the machine, or too old. | Install or update Claude Code, then type the restart command the item shows. |
| Problem on … | A check on the machine found an error; the item lists it. | Fix it on the machine, then type the restart command. |

Each machine item opens the machine's page. Details: [When a machine has a problem](machines.md#when-a-machine-has-a-problem). The item disappears once the daemon connects again without the problem.

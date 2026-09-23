# Needs you

**Needs you** is the home page of the Orchestrator. It lists everything waiting for you; when it is empty, nothing needs you. The number next to "Needs you" in the menu counts the items.

In this version, it shows problems with the GitHub connection and projects whose setup failed. Later versions add questions from agents, plans to approve and pull requests to merge.

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

# Connect GitHub

The Orchestrator works on GitHub for you: it creates repositories, pushes branches and opens pull requests. It does so with a **fine-grained personal access token**: a kind of password, created on GitHub, that gives only the rights listed below, only on your personal account.

You enter the token in the setup wizard, and later in **Settings > GitHub connection**. Once saved, the token is stored encrypted and never shown again, not even to you.

## Create the token

1. In the Orchestrator, click **Create the token on GitHub**. GitHub opens its "New fine-grained personal access token" form in a new tab, with the name "Orchestrator", a one-year expiry date and the permissions already filled in. Log in to GitHub if it asks.
2. Check that **Resource owner** is your own GitHub account (it is by default).
3. Under **Repository access**, choose **All repositories**. This is the one setting the button cannot fill in. The Orchestrator creates new repositories for your projects later; with "All repositories" the token covers them from the start. With "Only select repositories", every new repository would be out of the Orchestrator's reach.
4. Leave the other settings as they are and click **Generate token** at the bottom of the page. Confirm if GitHub asks.
5. Copy the token: it starts with `github_pat_`. GitHub shows it only once. If you lose it before saving it in the Orchestrator, delete it on GitHub and create a new one.
6. Note the expiry date GitHub shows for the token.

**Keep an expiry date.** One year is a good choice: a token that never expires stays usable forever by anyone who finds it. The Orchestrator reminds you before the date.

## Enter the token in the Orchestrator

1. Paste the token and click **Continue**. The Orchestrator asks GitHub which account the token belongs to and shows it.
2. Check the **Expiry date**: enter the date GitHub showed. The Orchestrator fills it in when GitHub tells it, but GitHub does not always do so. If you chose "No expiration" on GitHub, tick **No expiry date**.
3. Click **Save and check**.

## The permissions check

GitHub cannot tell the Orchestrator which permissions a token has, so the Orchestrator tries harmless requests with it. It never creates or changes anything on GitHub while checking. Each permission then shows:

| Result | Meaning |
|---|---|
| **OK** | The permission is granted. |
| **Missing** | The permission is not granted: the Orchestrator will fail when it needs it. Create a new token with the button (it fills in every permission) and enter it. |
| **Could not verify** | The check could not tell, for example because your account has no private repository to test on, or GitHub could not be reached. This is not necessarily a problem: GitHub reports any missing permission when the Orchestrator really uses it, and "Needs you" then tells you. |
| **Could not verify** for Pull requests | Pull requests is checked twice, once for reading (on one of your private repositories) and once for writing, and shows **OK** only when both are. Without a private repository, its reading cannot be checked. |
| **Could not verify**, "Requires Contents (Read and write) first" | Workflows can only be checked once Contents is OK. Fix Contents first (a new token made with the button), then Workflows shows its real result. |

## Required permissions

The button fills these in. They are listed here if you create the token by hand.

| Setting on GitHub | Value | What the Orchestrator does with it |
|---|---|---|
| Repository access | All repositories | Covers the repositories it creates later. |
| Administration | Read and write | Creates repositories and protects their main branch. |
| Contents | Read and write | Commits the first files, creates branches. |
| Pull requests | Read and write | Opens pull requests and posts review comments, sees when you merge. |
| Workflows | Read and write | Adds the automatic checks (GitHub Actions) to projects. |
| Commit statuses | Read-only | Reads the result of automatic checks. |
| Actions | Read-only | Reads the automatic checks' runs and their logs. |
| Metadata | Read-only | Required by GitHub for any repository access; added automatically. |

Organizations are not supported: the token must belong to your personal account.

**What the token gives.** With these permissions on all your repositories, anyone holding the token can change and administer every repository of your account. The Orchestrator keeps it encrypted on the server and gives it to a machine only for one fetch or push at a time; in this version an agent running on that machine could still find a way to take it while its run is active ([Agents on your own user](machines.md#agents-on-your-own-user)). Keep the expiry date, and delete the token on GitHub at once if you suspect it was taken.

## Check or replace the token

In **Settings > GitHub connection** you see the GitHub account, the expiry date, when the token was saved and last checked, and the result of each permission.

- **Check again** runs the permissions check again, for example after changing the token's permissions on GitHub.
- **Replace the token** shows the same steps as the wizard. Use it before the token expires, or when "Needs you" reports a problem. The new token replaces the old one at once; you can then delete the old one on GitHub (Settings > Developer settings > Personal access tokens > Fine-grained tokens).

## When the token expires

"Needs you" warns you 14 days before the expiry date you entered (the **GitHub token expiry warning** setting, see [Settings](settings.md#settings-reference)), and again once it has passed. Create a new token and enter it with **Replace the token**. If GitHub refuses the token at any time (deleted, revoked, expired earlier than the date you entered), "Needs you" tells you too.

## If something goes wrong

| Message | What to do |
|---|---|
| This is not a fine-grained token | The token must start with `github_pat_`. Create it with the **Create the token on GitHub** button, not with "Tokens (classic)". |
| GitHub does not accept this token | Check that you copied all of it. If it was deleted or has expired, create a new one. |
| GitHub could not be reached | Check the computer's internet connection and try again. |
| The expiry date is in the past | Enter the date GitHub showed. If the token has really expired, create a new one. |
| "Enter your GitHub token again" in Needs you | The secret key changed: see [Back up your secret key](secret-key.md), then enter the token again. |

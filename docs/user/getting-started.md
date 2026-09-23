# Getting started

This guide installs the Orchestrator on a Windows computer, creates your account and connects it to GitHub. It takes about 20 minutes.

## What you need

- Windows 10 or 11 with **WSL 2** and an Ubuntu terminal. If you have never used WSL, follow Microsoft's guide "Install WSL" first.
- **Docker**: Docker Desktop with the WSL integration turned on for Ubuntu, or Docker Engine installed inside Ubuntu.
- **Git** in Ubuntu (`sudo apt install git` if the `git` command is missing).
- A **GitHub account**.

Every command below is typed in the Ubuntu terminal.

## 1. Get the Orchestrator

```sh
git clone git@github.com:msincikpaeerl/orchestrator.git ~/orchestrator
cd ~/orchestrator
```

## 2. Create the configuration file

1. Copy the example file:

   ```sh
   cp .env.example .env
   ```

2. Create a secret key and write it into the file:

   ```sh
   sed -i "s#^ORCHESTRATOR_SECRET_KEY=.*#ORCHESTRATOR_SECRET_KEY=$(openssl rand -base64 32)#" .env
   ```

3. Back up this key now: see [Back up your secret key](secret-key.md). The Orchestrator uses it to protect your GitHub token.

The Orchestrator opens on port 8080. If another program already uses that port, open `.env` (`nano .env`) and change the line `PORT=8080`, for example to `PORT=8090`; then use that number instead of 8080 below.

## 3. Start the Orchestrator

```sh
docker compose -f docker/compose.yml up -d --build
```

The first start takes a few minutes. It is ready when this command shows `healthy` next to both `orchestrator` and `postgres`:

```sh
docker compose -f docker/compose.yml ps
```

The Orchestrator starts again by itself when the computer or Docker restarts.

## 4. Create your account

1. In your Windows browser, open `http://localhost:8080`. The setup wizard appears.
2. Choose a username and a password of at least 12 characters, type the password twice, then click **Create the account**.

You are the only user. If you forget the password, see [Reset a forgotten password](reset-password.md).

## 5. Connect GitHub

The second step of the wizard connects the Orchestrator to your GitHub account with a token, a kind of password that gives only the rights the Orchestrator needs.

1. Click **Create the token on GitHub**. GitHub opens its token form with everything filled in except one setting.
2. Under **Repository access**, choose **All repositories**.
3. Click **Generate token**, then copy the token GitHub shows.
4. Back in the Orchestrator, paste the token and click **Continue**.
5. Check the expiry date (the date GitHub showed), or tick **No expiry date** if you chose no expiry on GitHub, then click **Save and check**.
6. The Orchestrator checks the token and shows **OK**, **Missing** or **Could not verify** for each permission. Click **Continue**.

Details and answers to common problems: [Connect GitHub](github-token.md).

## 6. Done

The wizard ends on the **Setup done** page. From there:

- **Help** (in the menu) contains this guide and every other page.
- **Needs you** is the home page: it lists what needs your attention, such as a GitHub token about to expire. See [Needs you](needs-you.md).

On a phone or a small window, the menu is behind the **Menu** button at the top.

## Stop, start and update

| To | Type in `~/orchestrator` |
|---|---|
| Stop the Orchestrator (your data is kept) | `docker compose -f docker/compose.yml down` |
| Start it again | `docker compose -f docker/compose.yml up -d` |
| Update to the latest version | `git pull`, then `docker compose -f docker/compose.yml up -d --build` |
| See its messages when something goes wrong | `docker compose -f docker/compose.yml logs orchestrator` |

## If something goes wrong

| Problem | What to do |
|---|---|
| `Set ORCHESTRATOR_SECRET_KEY in .env` | The key is missing: do step 2 again. |
| `port is already allocated` | Another program uses port 8080: change `PORT` in `.env` (step 2), then start again. |
| `Cannot connect to the Docker daemon` | Start Docker Desktop (or Docker in Ubuntu), then start again. |
| The page does not open in the browser | Wait until `docker compose -f docker/compose.yml ps` shows `healthy`, then reload. |
| You want to open the Orchestrator from your phone | See [Open the Orchestrator from another device](network-access.md). |

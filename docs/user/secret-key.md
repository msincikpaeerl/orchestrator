# Back up your secret key

The Orchestrator encrypts your GitHub token with a secret key before storing it. Without this key, nobody can read the token from the database or a backup of it, including the Orchestrator itself.

## Where it is

The key is the line `ORCHESTRATOR_SECRET_KEY=...` in the `.env` file, in the folder where you installed the Orchestrator. You created it when you installed the Orchestrator.

## Back it up

1. Open the `.env` file, for example with `nano ~/orchestrator/.env`.
2. Copy the whole value after `ORCHESTRATOR_SECRET_KEY=`.
3. Keep it somewhere safe outside this computer, for example in your password manager.

Never share it and never put it in a GitHub repository.

## Do not change it

Keep the same key for the life of your installation, including when you move the Orchestrator to another computer: copy the `.env` file with it.

## If the key is lost or changed

The Orchestrator keeps working, but it can no longer read your GitHub token:

- "Needs you" shows **"Enter your GitHub token again"**;
- nothing that needs GitHub works until you do.

To fix it, create a new token on GitHub (or use the one you have, if you kept it) and enter it in Settings > GitHub connection. Your account, password and everything else are not affected.

If you find the old key again, you can also put it back in `.env` and restart the Orchestrator: `docker compose -f docker/compose.yml up -d`.

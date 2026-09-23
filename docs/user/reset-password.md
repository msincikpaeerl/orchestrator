# Reset a forgotten password

The Orchestrator has no email address, so a forgotten password cannot be reset from the login page. You reset it with a command on the computer where the Orchestrator runs.

## Steps

1. Open a terminal on that computer (on Windows, open your WSL terminal, for example Ubuntu).
2. Go to the folder where you installed the Orchestrator, for example:

   ```sh
   cd ~/orchestrator
   ```

3. Run:

   ```sh
   docker compose -f docker/compose.yml exec orchestrator orchestrator reset-password
   ```

4. Type the new password when asked, then type it again. Nothing appears on the screen while you type: this is normal. The password needs at least 12 characters.
5. When the message "Password changed" appears, log in on the web page with your username and the new password.

## What happens

- Every open session is logged out, on every device: log in again everywhere.
- The change is recorded in the Orchestrator's activity log.
- Your username, projects and GitHub connection do not change.

## Too many failed logins

After several wrong passwords, the login page asks you to wait before trying again, and the wait grows with each new mistake (up to 15 minutes; these values are settings, see [Settings](settings.md#settings-reference)). This protects your account against someone guessing the password. Resetting the password with the command above also lifts the wait.

## If something goes wrong

| Message | What to do |
|---|---|
| `The password must have at least 12 characters.` | Run the command again with a longer password. |
| `The two passwords are different.` | Run the command again and type the same password twice. |
| `There is no owner account yet` | The account was never created: open the Orchestrator in your browser and follow the setup wizard. |
| `service "orchestrator" is not running` | Start the Orchestrator first: `docker compose -f docker/compose.yml up -d`. |

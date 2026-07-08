# Meet the Cows — working notes for Claude

## Git

- **Never push to `main` without the user's explicit approval.** Do all development on feature
  branches and push those freely. For any push to `main`, ask first and wait for a clear yes.
  This is enforced by the `PreToolUse` hook in `.claude/settings.json`
  (`.claude/hooks/guard-push-to-main.sh`), which prompts for confirmation before any push to
  `main` — but honor it regardless of whether the hook is active in the current session.

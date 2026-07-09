# Meet the Cows — working notes for Claude

## Git

- **Never push to `main` without the user's explicit approval.** Do all development on feature
  branches and push those freely. For any push to `main`, ask first and wait for a clear yes.
  This is enforced by the `PreToolUse` hook in `.claude/settings.json`
  (`.claude/hooks/guard-push-to-main.sh`), which prompts for confirmation before any push to
  `main` — but honor it regardless of whether the hook is active in the current session.
- **Commit as the repo owner, not as Claude.** At the start of any session, before the first
  commit, run:
  `git config user.name "Fabien Broquet" && git config user.email "fbroquet@pm.me"`
  (sessions start from a fresh clone, so this must be re-applied every session). Keep the
  `Co-Authored-By: Claude …` trailer in commit messages so authorship stays honest.

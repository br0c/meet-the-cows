#!/usr/bin/env bash
# PreToolUse(Bash) guard: require explicit user approval before any git push to the main branch.
#
# Reads the hook JSON on stdin, inspects the Bash command, and returns permissionDecision "ask"
# (which prompts the user) when the command pushes to main. Everything else passes through
# untouched. "ask" — not "deny" — so an approved push to main still succeeds; it just can never
# happen without the user confirming first.

cmd="$(jq -r '.tool_input.command // empty' 2>/dev/null || true)"
[ -n "$cmd" ] || exit 0

# Only look at git push commands (handles compound commands like `cd x && git push ...`).
printf '%s' "$cmd" | grep -Eq '\bgit\b([[:space:]]+-[^[:space:]]+)*[[:space:]]+push\b' || exit 0

ask() {
  jq -n --arg r "$1" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"ask",permissionDecisionReason:$r}}'
  exit 0
}

# Explicit main destination: "... main", "...:main", "...refs/heads/main".
if printf '%s' "$cmd" | grep -Eq '(:|/|[[:space:]])main([[:space:]]|$)'; then
  ask "This git push targets the main branch. Project guardrail: get the user's explicit approval before pushing to main."
fi

# Bare push (no explicit refspec) while checked out on main.
branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
if [ "$branch" = "main" ]; then
  ask "The current branch is main and this is a git push. Project guardrail: get the user's explicit approval before pushing to main."
fi

exit 0

# Meet the Cows — working notes for Claude

## Git

- **New work goes to `dev`, never straight to `main`.** `main` is what pilots are flying; it
  changes only once something has been proven on `dev` at its own deployment. This includes
  changes that look too small to need testing — the ones that turn out to matter are rarely the
  ones that looked risky. `main` still takes fixes to things already broken in production.
- **Never push to `main` without the user's explicit approval.** Do all development on feature
  branches and push those freely. For any push to `main`, ask first and wait for a clear yes.
  This is enforced by the `PreToolUse` hook in `.claude/settings.json`
  (`.claude/hooks/guard-push-to-main.sh`), which prompts for confirmation before any push to
  `main` — but honor it regardless of whether the hook is active in the current session.
- **Check HEAD against the remote before the first edit of any task — and `git fetch` first.**
  The container can be restored mid-session from an older snapshot: work you already pushed is
  safe, but the working tree silently rewinds and then accepts edits without complaint. A change
  made on a stale base looks fine in the diff while quietly reverting everything committed since
  the snapshot. Observed several times in one session, always back to the same commit.
  The fetch is the part that matters. The snapshot restores `.git` too, so the stale
  remote-tracking refs agree with the stale HEAD and `HEAD == origin/dev` reports "in sync"
  while both are weeks behind. Fetch, then compare:
  `git fetch origin dev && git rev-parse --short HEAD origin/dev` — if they differ,
  `git checkout -B dev origin/dev` and re-apply, and re-run `git config user.name/email` because
  the snapshot loses those too.
  The tells, when it happens without being noticed: files that existed are missing (`git ls-files`
  disagrees with what you remember), or a constant you changed is back to its old value.

- **Commit as the repo owner, not as Claude.** At the start of any session, before the first
  commit, run:
  `git config user.name "Fabien Broquet" && git config user.email "fbroquet@pm.me"`
  (sessions start from a fresh clone, so this must be re-applied every session). Keep the
  `Co-Authored-By: Claude …` trailer in commit messages so authorship stays honest.

## Shipping a change to installed apps

`APP_VERSION` (in both `src/app.js` and `service-worker.js`) is what makes a change reach a
phone that already has the app. The shell cache is named after it, and the worker only
reinstalls when its own bytes change — so a change that touches **neither** file reaches nobody
until the pilot happens to relaunch twice, and an installed PWA that is resumed rather than
relaunched may never do that.

This bites hardest for things that are not app code at all. `deploy/app-csp.txt` is a **response
header**, and the header is cached with the document: 0.8.7-beta's CSP fix was correct at the
origin and still blocked every place search on installed apps, because no shell file changed.
Measured: with no version bump the fix arrives on the second full relaunch; with one it arrives
on the first, and the "new version is ready" banner offers it without a relaunch at all.

**Bump `APP_VERSION` for anything that changes what a pilot's cached app does** — app code,
`index.html`, `styles.css`, and the deploy headers alike. Scripts, tests and CI are exempt.

## Release notes

`release-notes.json` is read by pilots in the app, not by maintainers. Every release must have an
entry for its `APP_VERSION` — CI refuses to deploy without one — but the entry should be short.

- **One short line per change, saying what changed.** Never why, never how. The mechanism belongs
  in the commit message, where someone debugging it will actually look for it.
- **Small technical fixes collapse into a single "Bug fixes" line.** A pilot does not need to know
  that a cache key was wrong, only that the thing works now.
- **Group related changes onto one line** rather than listing each switch and label separately.
- **A second sentence only where a caveat changes what a pilot does** — "experimental, off by
  default", "do it on Wi-Fi". Otherwise one sentence is the whole entry.
- **Safety-relevant fixes stay explicit,** briefly. Someone who hit the bug in the air should
  recognise it in the list; that costs a dozen words, not a paragraph.
- Write all three languages (`en`, `fr`, `de`) to the same shape. Do not translate a long English
  line — write the short line in each.

For scale: 0.8.6-beta covered nine changes in six lines and 72 words.

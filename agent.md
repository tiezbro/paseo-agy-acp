# Git authorship — hard rule

This repository’s GitHub **Contributors** graph must list **only** the human maintainer (`tiezbro`). Cursor / Cursor Agent / `cursoragent` is **never** a contributor.

Cursor’s `git commit` wrapper appends this trailer even when the agent did not ask for it:

```
Co-authored-by: Cursor <cursoragent@cursor.com>
```

GitHub treats that trailer as a second author. One such commit on `main` puts **cursoragent** back in the sidebar.

## Before every commit

1. Write the message yourself. Do not add any `Co-authored-by` line.
2. Prefer `git commit-tree` (bypasses Cursor’s wrapper) or a local `prepare-commit-msg` hook that deletes the Cursor trailer.
3. Immediately run `git log -1 --format=%B`.
4. If the body contains `Co-authored-by: Cursor` or `cursoragent@cursor.com`, **do not push**. Strip the trailer and rewrite the commit first.

Strip + rewrite without Cursor re-injecting the trailer:

```bash
git log -1 --format=%B | grep -vi '^Co-authored-by:.*cursor' > /tmp/paseo-commit-msg
tree=$(git rev-parse HEAD^{tree})
parent=$(git rev-parse HEAD^)
export GIT_AUTHOR_NAME="$(git log -1 --format=%an)"
export GIT_AUTHOR_EMAIL="$(git log -1 --format=%ae)"
export GIT_AUTHOR_DATE="$(git log -1 --format=%aD)"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
new=$(git commit-tree "$tree" -p "$parent" -F /tmp/paseo-commit-msg)
git reset --hard "$new"
git log -1 --format=%B   # must show no Cursor trailer
```

## If it already landed on `main`

Rewrite the commit, then `git push --force-with-lease forgejo main`. GitHub is the Forgejo **push mirror**.

**Never** toggle the GitHub repo public ↔ private to hide a contributor. That deletes stars and forks.

## Push

Push to `forgejo` only (`ssh://git@192.168.6.10:222/tiezbro/paseo-agy-acp.git`). Do not `git push origin` unless the maintainer explicitly asks.

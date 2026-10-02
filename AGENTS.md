# Working on Interface

Interface is an Electron/React desktop app that connects to locally installed Claude Code and Codex CLIs. Keep macOS and Ubuntu behavior in mind; platform-specific APIs must have a guarded fallback. Do not claim platform behavior has been tested unless you ran it there.

## Scope and validation

- Read the current task and inspect the working tree before editing. In shared sessions, respect file ownership in `.collab/*/tasks.md` and coordinate overlapping edits.
- Keep credentials, account directories, chat transcripts, screenshots containing private data, `.collab/`, dependencies and build output out of commits. `.gitignore` is a baseline, not a secret scanner.
- Preserve uncommitted and divergent work. Do not reset, discard, force-push, sweep files into a commit, or rewrite existing commits unless the user specifically asks.
- For completed code changes, run `npm run typecheck`, `npm test`, and `npm run build`. Add focused tests for meaningful behavior changes. Describe any checks you could not run.
- Keep the README and Ubuntu handoff accurate when workflows or platform behavior change.

## Repository and commit identity

The public repository is `https://github.com/Masudali23/interface-agent-desktop`. The branch roles are `main` for reviewed integration, `mac` for macOS work, and `ubuntu` for Ubuntu work.

Every new commit must have both author and committer set to:

```text
Masudali23 <alimasud2023@gmail.com>
```

Use descriptive human-readable commit messages. Do not add AI attribution, generated-by statements, or co-author trailers. Do not alter other repositories or the user's global Git identity.

## Finish completed coding sessions

The user has authorized committing and pushing completed work in this repository at the end of future coding sessions: macOS changes go to `mac`, Ubuntu changes go to `ubuntu`. This standing authorization covers reviewed task files and ordinary non-forced pushes to the repository above. It does not authorize unrelated edits, publishing private data, destructive sync, or changing repository visibility.

Inspect the diff and choose explicit files, then run:

```bash
bash scripts/session-sync.sh --branch mac --message "Describe the completed change" -- src/example.ts tests/example.test.ts
```

Use `--branch ubuntu` on Ubuntu. Replace the example paths with the actual reviewed files, including both old and new paths for a rename. The script validates the remote, current branch, index and outgoing commit identity; fetches the matching remote branch; runs the checks above; and commits/pushes only those paths. It refuses branches that need integration. Existing staged changes must be handled by their owner before running it.

If validation fails, preserve the work, fix task-related failures where possible, and report the exact blocker. If the current branch is wrong or has diverged, inspect and integrate deliberately; do not switch dirty branches or auto-stash. If a push fails after a commit, retain the commit and report its hash. Do not create empty commits just to satisfy this workflow. Report the commit, branch, push result and validation in the final handoff.

For importing macOS work on Ubuntu, follow [`docs/ubuntu-handoff.md`](docs/ubuntu-handoff.md). Remote changes and local changes both need review before integration.

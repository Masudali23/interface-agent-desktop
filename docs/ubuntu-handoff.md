# Ubuntu handoff

Repository: <https://github.com/Masudali23/interface-agent-desktop>. The `mac` branch receives macOS work, `ubuntu` receives Ubuntu work, and `main` is the shared integration branch. Local sessions, credentials, dependencies and build artifacts stay on their original machine.

Paste the following prompt into the Ubuntu coding session. Supply the local checkout path in the first line. It is intended for both a fresh clone and an existing checkout with local work.

```text
Work on Interface in <LOCAL_CHECKOUT_PATH> on Ubuntu. Read AGENTS.md before editing. The expected public repository is https://github.com/Masudali23/interface-agent-desktop, with main/mac/ubuntu branches. Bring the relevant completed macOS improvements onto ubuntu, preserve all Ubuntu work, validate the app here, and commit/push the completed Ubuntu changes.

First inspect the current directory, origin fetch and push URLs, branch, Git status (including untracked files), staged diff, working diff and recent commit graph. Do not print credentials or account files. If there is no checkout, clone the expected repository into an unused directory and check out ubuntu. Never replace an existing directory or initialize a new repository over unknown files.

If a checkout exists, validate the origin before fetching. Fetch main, mac and ubuntu without modifying local files. Identify local commits missing from origin/ubuntu and commits on origin/mac that ubuntu has not incorporated. Review the actual changes before choosing merge or cherry-pick; account for equivalent changes already made independently on Ubuntu. Do not treat origin/mac as a replacement for the Ubuntu tree.

Preserve every pre-existing local edit, staged change, untracked file and local commit. Do not reset, clean, force-push, auto-stash, switch dirty branches, or commit unrelated work to make the tree clean. If this checkout has local work or is on another branch, perform integration in a new worktree and temporary integration branch created from the intended Ubuntu tip; leave the original checkout and index untouched. Review divergent local Ubuntu commits as part of choosing that tip. Report what remains in the original checkout. Ask for a decision only when conflicting user intent cannot be resolved safely from the changes.

Integrate the relevant macOS commits and preserve Ubuntu-specific fixes. Resolve conflicts deliberately, explaining choices that affect behavior. Review the live Changes panel and file preview/watch behavior, session sharing, mid-turn feedback, team lead/delegation controls, model/effort settings, permissions and terminal behavior. Do not assume passing macOS tests proves Ubuntu desktop behavior.

Use Node 22 (22.12 or newer), install dependencies with npm ci on this machine, then run npm run typecheck, npm test and npm run build. Build the Ubuntu installer with npm run dist:linux if packaging tools are available. Test the actual Ubuntu app when a graphical session and authenticated CLIs are available. Report checks that could not run; do not claim the installer or login flow worked without testing them.

Before every new commit, set both author and committer to Masudali23 <alimasud2023@gmail.com> for this repository/command only. Use clear commit messages with no co-author or AI-generated trailers. Do not rewrite existing local commits to change their identity; if a pending commit has another identity, report it and preserve it. Stage only reviewed task files by explicit path, and keep .collab, credentials, application data, node_modules and build output untracked.

The user has authorized normal commits and pushes of completed Ubuntu work to the expected repository. In a clean ubuntu checkout that contains the fetched origin/ubuntu tip, use scripts/session-sync.sh --branch ubuntu --message "<specific change>" -- <explicit files>. If integration was done in an isolated worktree, preserve the original checkout: after checking the complete outgoing commit range, owner identities, tests and remote state, push the reviewed integration commit to refs/heads/ubuntu with an ordinary non-forced push. Never force an update or switch the user's dirty original checkout. A remote advance requires another deliberate integration, not a reset.

Finish by reporting the integrated source commits, Ubuntu commit hash, branch and push result; tests and runtime checks; conflicts and unresolved differences; and the location/status of any original local work and temporary integration worktree. Keep main/mac unchanged unless a later instruction specifically asks to update them.
```

The prompt does not guarantee a conflict-free merge. For a failed push, keep the local commits and inspect the updated remote before trying again. Worktrees and backup branches should remain available until their owner confirms the preserved work is no longer needed.

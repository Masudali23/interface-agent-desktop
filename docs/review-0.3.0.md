# Interface 0.3.0 review

This update adds file-by-file review and improves session orchestration. It does not claim full feature parity with VS Code, Claude Desktop or the Codex desktop app.

## Review changes

Open **Changes** in the session header. **Working tree** shows current Git changes; **This chat** shows recorded turn patches and edit excerpts. Select a filename to see additions in green, removals in red, line numbers, and syntax highlighting. Switch between **Unified** and **Before / after**, filter the file list, drag the panel edge to resize it, or open the current file.

**Follow edits** selects reported edits as they arrive. Selecting a different file or closing the panel pauses following. Shell changes appear in live Git refreshes while the panel is open; Git turn snapshots also capture them when a reply finishes. Folders without Git can show recorded edit events, but an agent's unrecorded shell edits cannot be reconstructed. Edit excerpts may not contain the original whole file or its absolute line positions.

Git changes handle new, deleted, renamed, staged, binary and conflicted files, including unusual filenames and repositories without an initial commit. A shared-folder snapshot can include another agent's concurrent edits. Such turns cannot be undone as a single agent's work. Undo also refuses to overwrite later edits to affected files. Separate worktrees provide independent change histories.

## Session and team controls

Use the pencil beside the session title to rename it. Enter saves; Escape cancels. In **Session settings**, choose a lead agent or send to all ticked agents in parallel. New team sessions start in lead mode; existing sessions retain their previous recipient behavior. Explicit @mentions still select recipients for that message.

The lead receives the initial task, delegates a bounded task through a handoff, and reviews the returned result. One reply has one routing target. Optional settings such as `→ @worker [model=MODEL_ID effort=low]: task` apply to that delegated turn. Models and efforts must be available in the account's catalog. Saved member settings are not overwritten. A visible manual-send action remains when automatic handoffs are disabled, an agent is unticked, settings are invalid or the hop limit is reached. Choosing an appropriate model reduces duplicate work; the app does not estimate provider prices or guarantee a token saving.

Feedback successfully delivered during a reply is retained for retry. Editing such feedback rewinds its consuming reply. Queued handoffs keep their separate tasks and settings. Stopping or closing a session prevents a delayed filesystem snapshot from launching a stopped agent.

## Validation

The automated suite covers Git diff/undo/worktrees, directory watching and file boundaries, diff parsing, routing and recipients, connector overrides, steering and room lifecycle, exports, and usage formatting. The normal commands are `npm run typecheck`, `npm test`, and `npm run build`.

An isolated macOS Electron instance used a temporary Git project and synthetic account/session data, with provider binaries disabled. UI checks covered live refresh despite unchanged line counts, numbered diffs, before/after view, deleted-file handling, recorded edits without Git, automatic follow and closing the panel, session rename save/cancel, and lead/parallel controls. A real 980×620 window was checked with four agents, Changes and the terminal open; the terminal no longer overlaps the composer and the chat retains a scrollable area.

Connector and delegation regressions use mocked CLI transports, not paid requests. Native trackpad behavior and authenticated model/effort handoffs still need a person and real accounts for full end-to-end validation. CI checks macOS and Ubuntu; Ubuntu graphical behavior and Linux installers must be tested on the Ubuntu machine using [the handoff prompt](ubuntu-handoff.md).

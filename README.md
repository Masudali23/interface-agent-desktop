# Interface

Interface is a desktop workspace for Claude Code and Codex on macOS and Ubuntu. Work with one agent or coordinate several accounts in a shared conversation, using folders on your own computer.

The app launches the installed agent CLIs and uses their authentication, model access and usage limits. Claude uses its control protocol; Codex uses `app-server`, with a reduced-feature fallback for older CLI versions. Provider features depend on your installed CLI, account and platform. Interface does not provide a hosted model service.

## What it does

- **Claude Code desktop layout:** a sidebar of projects with their sessions listed under them, a session header with its own menu and side-panel buttons, and a **Session overview** panel showing the folder and Git branch, context use per agent, MCP connectors and account limits.
- **Projects:** a project is a folder your agents work in. **Add project** (⌘O on macOS, Ctrl+O on Ubuntu) saves a folder as a project and opens **New session** in it; the project stays listed if you cancel. Every project is listed under the Claude Code, Codex and Team tabs, even before it has sessions of that type. Its **+** button starts a session there, and that session is listed under the project. Folders of existing sessions become projects automatically. Pinned sessions stay at the top of their project. A project whose folder was moved or deleted reports that instead of starting a session. **Remove project** is available once a project has no sessions; it only removes the project from Interface's list, not the folder. The project menu's **Reveal in Finder** (macOS) or **Open folder** (Ubuntu, opens the folder itself) shows its files.
- **Accounts and sessions:** multiple accounts, model and effort controls, selected team recipients, usage displays (including per-model weekly limits such as "Weekly · Fable"), permission prompts, session search and a built-in terminal.
- **Live progress:** replies read as plain text. Tool calls collapse into one activity row per step group ("Ran 2 commands, read a file"); a running step shows what it is doing and for how long ("Running a command 38s"). The agent's task list appears as a checklist, and a running turn ends with a live line of elapsed time, output tokens and current activity.
- **Feedback while agents work:** press Enter to send a message into the running turn, or ⌘↵ (Ctrl+Enter on Ubuntu) to queue it as the next turn. Sent feedback appears in the conversation where you sent it, and the agent's further work continues below it; the task list from before your message is repeated under it until the agent updates it. Queued messages wait above the composer, where you can send them now, edit them or remove them; stopping an agent puts its queued messages back into the composer. Agent handoffs also join an active turn where the connector supports it. Accepted updates are recorded once rather than repeated as a later turn. Messages wait for the next turn when the connector cannot accept them; slash commands and handoffs requesting a different model/effort run separately.
- **Attachments:** paste, drop or add files with **+**. Images appear as thumbnails in the composer and in the conversation; click one to preview it.
- **Connected agent panels:** team rooms start in **Shared chat**. Switch to **Agent panels** to see one scrolling workspace per member, with its own status, model controls and composer. Pane messages go to that agent only (even when their text mentions someone else) and remain visible in the shared room. The room composer keeps its usual recipient selection and @mentions. Expand one panel to focus, or switch back at any time; drafts and attachments survive view changes. The layout preference is saved per room on this device.
- **Team coordination:** a lead can delegate bounded tasks to selected agents, with optional model/effort choices for delegated turns. Saved agent preferences remain available for later turns. Teams share a task board and can use separate Git worktrees.
- **Changes:** live Git status and file-by-file diffs, file previews, and worktree review. The Changes panel refreshes while visible; filesystem watching also updates the file tree. Binary files and preview limits are shown instead of treating every file as text.
- **Document preview:** click a local file link or attachment in Shared chat or Agent panels to open it on the right. Markdown renders in the panel; code has highlighting and line numbers; PDFs use the built-in viewer with thumbnails, page navigation and zoom; images display directly. The resizable panel has previous/next document, refresh, open in default app, reveal and close controls. Incoming file activity leaves an open document in place. Web links open in your browser.
- **Conversation sharing:** copy recorded chat as Markdown, save a Markdown export or an archive with recorded attachments, and use the native sharing menu on macOS. Exports contain recorded information; they cannot reconstruct unrecorded agent internals or missing attachments.
- **Retry and undo:** retry replies, edit earlier messages, and undo supported file changes. Coverage depends on the connector, available checkpoints and whether the folder is a Git repository.

This is an actively developed personal desktop app. macOS and Ubuntu share the source and CI checks, but window behavior, authentication flows, native dependencies and packaging still need testing on each OS. Builds are not presented as fully equivalent or commercially signed releases.

Live feedback reaches Claude Code and Codex app-server at the next point their running turn can accept input; it does not cancel a tool already executing. The older Codex `exec` fallback cannot receive mid-turn input and keeps it queued. Agent panels use the same room history, sessions, task board and delivery rules as shared chat; they are connected panes inside the app, not separate operating-system windows. Incoming agent handoffs appear in the receiving pane, and **Shared chat** shows the full team history.

File links can be absolute, project-relative, `file://` URLs or include `:line[:column]` / `#L12` targets. Relative chat links use the author's worktree when present; links inside a preview use that document's folder. Markdown line targets open Source mode, with Rendered available beside it. Access stays within the current session's project and worktrees, including symlink checks. Missing or inaccessible files show an error. Binary files have an explicit **Open in default app** action; local HTML is shown as source. Text previews are limited to 512 KB. **Files**, **Changes** and **Preview** tabs let you return to the current document without finding its chat link again.

## Develop locally

Use Node.js 22.12 or newer within Node 22, npm, Git, and an installed Claude Code and/or Codex CLI. Sign in through the CLI or the app's account flow. Native terminal dependencies may require Python 3 and a C/C++ build toolchain: Xcode Command Line Tools on macOS, or `build-essential` on Ubuntu.

```bash
git clone https://github.com/Masudali23/interface-agent-desktop.git
cd interface-agent-desktop
git switch mac # use ubuntu on Ubuntu
npm ci
npm run dev
```

Install dependencies separately on each computer. Do not copy `node_modules` or account directories between platforms.

```bash
npm run typecheck
npm test
npm run build
npm start
```

`npm start` previews the built application. CI runs install, typecheck, tests and build on macOS and Ubuntu with Node 22. Those checks do not sign installers or exercise real provider logins.

## Build installers

Run packaging on the target OS after installing dependencies:

```bash
# Apple Silicon macOS
npm run dist:mac

# Ubuntu x64
npm run dist:linux
```

Artifacts are written to `dist/`. macOS produces an ARM64 DMG and ZIP with an ad-hoc signature, without notarization. Ubuntu produces x64 AppImage and Debian packages. Use the actual generated filename when installing a Debian package, for example `sudo apt install ./dist/<generated-file>.deb`. Linux desktop libraries and AppImage runtime support depend on the distribution. Validate an installer on the intended machine before distributing it.

## Accounts and local data

The primary accounts use the CLI configuration in `~/.claude` and `~/.codex`. Additional accounts have isolated configuration directories under Interface's application data folder. The app supports copying selected settings, skills and MCP configuration from the primary account; authentication and usage behavior still come from the underlying tools.

Default application data locations are `~/Library/Application Support/Interface` on macOS and `~/.config/Interface` on Ubuntu. They contain session state and may contain sensitive account data. `INTERFACE_USER_DATA` can select another application data directory. Keep these directories private.

Rooms write a local transcript and task board under `.collab/<session>/` in the project folder. These files, credential files and build output are excluded by this repository's `.gitignore`. Review exports before sharing them; they can include conversation content, local paths and attachments.

## Branches and completing a session

| Branch | Purpose |
| --- | --- |
| `main` | Reviewed shared integration |
| `mac` | macOS development and validation |
| `ubuntu` | Ubuntu development and validation |

Changes do not move automatically between these branches. Integrate reviewed commits deliberately, preserving local work on both computers. The reusable [Ubuntu handoff prompt](docs/ubuntu-handoff.md) covers an existing clone with local edits or divergent commits.

For a completed session on the matching branch, review the intended diff and provide explicit paths:

```bash
bash scripts/session-sync.sh --branch mac --message "Improve file preview refresh" -- src/main/files.ts tests/files.test.ts
```

Use `--branch ubuntu` on Ubuntu. The script verifies the repository and branch, requires an initially clean staging area, checks that the branch contains the fetched remote tip, runs typecheck/tests/build, and creates a commit with the configured owner identity before an ordinary push. Other unstaged files remain untouched. Directories, broad pathspecs and implicit staging are not accepted. Both sides of a rename must be listed.

If the remote has advanced or the branches diverge, the script stops for deliberate integration. If pushing fails after committing, the commit remains local; inspect it and the remote before retrying a normal push. The script does not merge, stash, reset, force-push, or scan for every possible secret.

## Source map

| Path | Purpose |
| --- | --- |
| `src/main/agents/` | Claude Code and Codex connectors |
| `src/main/accounts.ts` | Accounts, authentication, usage and models |
| `src/main/rooms.ts`, `protocol.ts` | Sessions, steering, team dispatch, handoffs and worktrees |
| `src/main/git.ts`, `files.ts`, `terminal.ts` | Git review, filesystem access and terminal backend |
| `src/main/chatExport.ts`, `exportMarkdown.ts` | Conversation exports |
| `src/renderer/` | React user interface |
| `tests/` | Unit and local integration tests |

For an optional end-to-end run against installed, authenticated CLIs, inspect `runE2E` in `src/main/index.ts`. It is enabled through `INTERFACE_E2E` and can generate real agent activity; the ordinary CI suite does not use it.

The source is publicly visible, but `package.json` currently declares `UNLICENSED`; no open-source license grant is included.

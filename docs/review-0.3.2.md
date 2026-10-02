# Interface 0.3.2 verification

Codex records full file contents for additions and deletions, and unified patches for updates. The tool card and recorded Changes view now share normalization that respects that distinction, including empty files, literal patch-like content and rename destinations. Completed edit records are cached so ordinary streamed text and usage updates do not rebuild every patch. Same-length content changes still invalidate the cache.

The working-tree diff viewer now coalesces refreshes for the selected file. A completed request can display while another refresh is pending; changing files still discards responses for the previous selection. Paths outside the project with a similar prefix are preserved.

Regression coverage includes native and normalized Codex tool/approval events, raw addition/deletion line counts, missing final newlines, empty files, rename paths, literal `a/` and `b/` directories, cache invalidation, and project path boundaries.

An isolated macOS Electron instance used synthetic accounts with disabled provider executables and a temporary project. UI checks verified:

- A folder without Git shows recorded additions in green and deletions in red, with accurate line counts and intact `---`, `+++`, `@@` and `diff --git` content.
- Empty files remain visible; deleted files cannot be opened as current files. Rename review links and before/after views select the destination correctly.
- Tool cards and the side panel show concise relative filenames and consistent counts.
- A deliberately delayed 650 ms diff appears while refreshes arrive every 75 ms. Only one request for that selection runs at a time; a late response cannot replace another selected file.
- At a real 980 × 620 window size, the document and side panel remain within the 620 px height.

Full validation uses `npm run typecheck`, `npm test` and `npm run build`, with CI on macOS and Ubuntu. These checks do not simulate a physical trackpad or establish Ubuntu desktop rendering. No paid model calls were needed for this patch.

The handoff delivery and bracket-label fixes from 0.3.1 are retained. The installation identifier is unchanged; public author and commit identity remain Masudali23.

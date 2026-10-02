import { describe, expect, it } from 'vitest'
import { chatExportFilename, formatChatMarkdown } from '../src/main/exportMarkdown'
import { DEFAULT_SETTINGS, type Message, type Room } from '../src/shared/types'

const exportedAt = Date.UTC(2026, 9, 2, 10, 0)

function room(messages: Message[] = []): Room {
  return {
    id: 'chat-1',
    title: 'Build a shared chat',
    folder: '/workspace/project',
    kind: 'team',
    createdAt: 0,
    updatedAt: exportedAt - 1000,
    members: [
      { id: 'claude', accountId: 'account-secret', provider: 'claude', name: 'Claude Work', handle: 'claude', color: '#fff', settings: { ...DEFAULT_SETTINGS, model: 'opus', effort: 'high' } },
      { id: 'gpt', accountId: 'other-account-secret', provider: 'codex', name: 'GPT Work', handle: 'gpt', color: '#000', settings: { ...DEFAULT_SETTINGS, model: 'gpt-6', effort: 'medium' } }
    ],
    active: ['claude'],
    autoRelay: true,
    maxHops: 6,
    isolation: false,
    sessions: { claude: 'provider-session-secret', gpt: 'another-session-secret' },
    messages
  }
}

function message(overrides: Partial<Message> = {}): Message {
  return { id: 'msg-1', author: 'claude', createdAt: 1000, text: '', blocks: [], status: 'done', ...overrides }
}

describe('formatChatMarkdown', () => {
  it('exports the complete recorded conversation, in order, with approvals, usage, routing, diffs and task board', () => {
    const exported = formatChatMarkdown(room([
      message({ id: 'user-msg', author: 'user', text: 'Implement the full feature.', to: ['claude', 'gpt'] }),
      message({
        text: 'I will implement it.\n\nImplemented successfully.',
        blocks: [
          { kind: 'text', id: 'intro', text: 'I will implement it.' },
          { kind: 'thinking', id: 'thinking', text: 'Recorded provider summary: check each existing boundary.' },
          { kind: 'tool', id: 'tool', name: 'Write', input: { file_path: 'src/feature.ts', content: 'export const enabled = true\n' }, output: 'Created src/feature.ts\nAll lines preserved.', status: 'done' },
          { kind: 'approval', id: 'approval', requestId: 'permission-id', toolName: 'question', input: { prompt: 'Choose a format' }, description: 'The complete approval explanation.', canAlways: false, status: 'answered', questions: [{ id: 'format', header: 'Format', question: 'Which sharing format should I use?', multiSelect: true, options: [{ label: 'Markdown', description: 'Portable text' }, { label: 'Archive', description: 'Include attachments' }] }], answers: { format: 'Markdown, Archive' } },
          { kind: 'error', id: 'error', text: 'A recoverable error was recorded.' },
          { kind: 'text', id: 'final', text: 'Implemented successfully.' }
        ],
        handoff: { to: 'user', text: 'Read the complete shared export.' },
        usage: { inputTokens: 3311000, cachedTokens: 3215000, outputTokens: 12000, steps: 21, durationMs: 226000 },
        diff: 'diff --git a/src/feature.ts b/src/feature.ts\n+export const enabled = true\n',
        undone: true,
        prompt: { text: 'internal-prompt-secret', attachments: [] },
        turn: { session: 'turn-session-secret', start: 'turn-start-secret' },
        snapshot: { before: 'snapshot-before-secret', after: 'snapshot-after-secret' }
      })
    ]), { exportedAt, taskBoard: '- [x] Implement feature — src/feature.ts' })

    for (const expected of [
      'Exported at: 2026-10-02T10:00:00.000Z', 'Provider: Claude Code', 'Model: opus', 'Effort: high', 'Provider: Codex', 'Model: gpt-6',
      'Recipients: Claude Work \\(@claude\\), GPT Work \\(@gpt\\)', 'Implement the full feature.', 'Recorded provider summary:',
      '"file_path": "src/feature.ts"', '"content": "export const enabled = true\\n"', 'All lines preserved.', 'Status: answered',
      'The complete approval explanation.', 'Which sharing format should I use?', '"description": "Portable text"', '"format": "Markdown, Archive"',
      'A recoverable error was recorded.', 'Implemented successfully.', '→ @user: Read the complete shared export.',
      'Input tokens, total (including cache reads): 3311000', 'Input tokens read from cache: 3215000', 'New input tokens: 96000',
      'Output tokens (including reasoning): 12000', 'Model calls: 21', 'Elapsed: 3 min 46 sec (226000 ms)', 'Undone: yes',
      'diff --git a/src/feature.ts b/src/feature.ts', '- [x] Implement feature — src/feature.ts'
    ]) expect(exported).toContain(expected)

    const ordered = ['Implement the full feature.', 'I will implement it.', 'Recorded provider summary:', '### 3. Tool:', '### 4. Approval:', '### 5. Error', 'Implemented successfully.', '### Routing', '### Recorded file changes', '## Task board']
    const positions = ordered.map((part) => exported.indexOf(part))
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    expect(exported.match(/Implemented successfully\./g)).toHaveLength(1)
    expect(exported).not.toContain('### Final reply')
    for (const secret of ['account-secret', 'provider-session-secret', 'internal-prompt-secret', 'turn-session-secret', 'turn-start-secret', 'snapshot-before-secret', 'snapshot-after-secret']) expect(exported).not.toContain(secret)
  })

  it('avoids duplicate aggregate or individual final replies, while preserving a distinct fallback reply', () => {
    const aggregate = formatChatMarkdown(room([message({ text: 'First\n\nLast', blocks: [{ kind: 'text', id: '1', text: '\nFirst\n' }, { kind: 'text', id: '2', text: '\nLast\n' }] })]), { exportedAt })
    expect(aggregate).not.toContain('### Final reply')
    const individual = formatChatMarkdown(room([message({ text: 'Last', blocks: [{ kind: 'text', id: '1', text: 'First' }, { kind: 'text', id: '2', text: 'Last' }] })]), { exportedAt })
    expect(individual).not.toContain('### Final reply')
    const fallback = formatChatMarkdown(room([message({ text: 'A separate final reply.', blocks: [{ kind: 'tool', id: 't', name: 'Shell', input: 'pwd', output: '/workspace/project', status: 'done' }] })]), { exportedAt })
    expect(fallback).toContain('### Final reply\n\nA separate final reply.')
  })

  it('uses fences longer than nested Markdown in thinking, tool outputs and file changes without truncation', () => {
    const content = 'Start\n```typescript\nconst x = 1\n```\n`````\nNested long fence\n`````\nEnd'
    const diff = '+++ b/example.md\n+``````\n+All content remains\n'
    const exported = formatChatMarkdown(room([message({ blocks: [{ kind: 'thinking', id: 'think', text: content }, { kind: 'tool', id: 'tool', name: 'Read', input: { file: 'example.md', content }, output: content, status: 'done' }, { kind: 'tool', id: 'string-input', name: 'Shell', input: content, status: 'running' }], diff })]), { exportedAt })
    expect(exported).toContain(`\n\`\`\`\`\`\`text\n${content}\n\`\`\`\`\`\``)
    expect(exported).toContain(`\n\`\`\`\`\`\`\`diff\n${diff}\`\`\`\`\`\`\``)
    expect(exported).toContain('``````json\n' + JSON.stringify({ file: 'example.md', content }, null, 2) + '\n``````')
    expect(exported.match(/Nested long fence/g)).toHaveLength(4)
    expect(exported).toContain('All content remains')
  })

  it('retains large outputs with many backtick runs without hitting the argument-count limit', () => {
    const output = 'x`'.repeat(150000) + '\nFinal exact output line.'
    const exported = formatChatMarkdown(room([message({ blocks: [{ kind: 'tool', id: 'tool', name: 'Shell', input: 'run', output, status: 'done' }] })]), { exportedAt })
    expect(exported).toContain(output)
    expect(exported).toContain('Previously clipped tool output cannot be recovered by exporting.')
  })

  it('exports portable attachment links and image previews, and explains missing files without exposing their local paths', () => {
    const image = { name: 'Screenshot [final].png', path: '/private/source/screenshot.png', mime: 'image/png', size: 12345 }
    const missing = { name: 'requirements.txt', path: '/private/source/missing.txt', mime: 'text/plain', size: 81 }
    const exported = formatChatMarkdown(room([message({ author: 'user', text: 'Use these files.', attachments: [image, missing] })]), {
      exportedAt,
      attachmentLink: (attachment) => attachment === image ? 'chat-assets/Screenshot [final] (1).png' : undefined,
      attachmentNote: (attachment) => attachment === missing ? 'File could not be found.' : undefined
    })
    expect(exported).toContain('[Screenshot \\[final\\].png](<chat-assets/Screenshot%20[final]%20(1).png>)')
    expect(exported).toContain('![Screenshot \\[final\\].png](<chat-assets/Screenshot%20[final]%20(1).png>)')
    expect(exported).toContain('Size: 12345 bytes')
    expect(exported).toContain('File could not be found.')
    expect(exported).not.toContain('/private/source/')
    expect(formatChatMarkdown(room([message({ attachments: [missing] })]), { exportedAt })).toContain('Attachment file is not included')
  })

  it('handles removed authors and recipients, routing to agents and DONE, empty rooms and live replies', () => {
    const archived = message({ author: 'removed', authorName: 'Archived Agent', provider: 'codex', text: 'Archived answer.', status: 'stopped', handoff: { to: 'gpt', text: 'Finish the review.' }, handoffDone: false })
    const user = message({ author: 'user', to: ['removed'], text: 'Review this.' })
    const live = message({ author: 'gpt', status: 'streaming' })
    const finished = message({ text: 'All done.', status: 'error', handoff: { to: 'done', text: '' } })
    const exported = formatChatMarkdown(room([archived, user, live, finished]), { exportedAt })
    expect(exported).toContain('## 1. Archived Agent')
    expect(exported).toContain('Recipients: Archived Agent')
    expect(exported).toContain('Status: stopped')
    expect(exported).toContain('Status: error')
    expect(exported).toContain('Reply is still in progress')
    expect(exported).toContain('→ GPT Work (@gpt): Finish the review.')
    expect(exported).toContain('Forwarded: no')
    expect(exported).toContain('→ DONE')
    const emptyRoom = { ...room(), members: [] }
    expect(formatChatMarkdown(emptyRoom, { exportedAt })).toContain('No messages yet.')
    expect(formatChatMarkdown(emptyRoom, { exportedAt })).toContain('No current participants.')
  })

  it('escapes metadata and attachment labels and retains zero-valued usage and empty tool outputs', () => {
    const unsafeRoom = room([message({ blocks: [{ kind: 'tool', id: 't', name: '<Script> [unsafe]', input: null, output: '', status: 'error', isError: true }], usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, steps: 0, durationMs: 0 } })])
    unsafeRoom.title = '[Chat](javascript:bad) <script>\n## forged heading'
    const exported = formatChatMarkdown(unsafeRoom, { exportedAt })
    expect(exported).toContain('# \\[Chat\\]\\(javascript:bad\\) &lt;script&gt; \\#\\# forged heading')
    expect(exported).not.toContain('\n## forged heading')
    expect(exported).toContain('Tool: &lt;Script&gt; \\[unsafe\\]')
    expect(exported).toContain('Reported an error: yes')
    expect(exported).toContain('```json\nnull\n```')
    expect(exported).toContain('#### Output\n\n```text\n\n```')
    expect(exported).not.toContain('No output recorded.')
    expect(exported).toContain('Model calls: 0')
    expect(exported).toContain('New input tokens: 0')
    expect(exported).toContain('Elapsed: 0 sec (0 ms)')
  })
})

describe('chatExportFilename', () => {
  it('returns a portable Markdown basename for unsafe, empty or reserved titles', () => {
    const unsafe = chatExportFilename({ id: 'id', title: '../../Chat: "hi" / a\\b?*<>|\u0000' })
    expect(unsafe).toMatch(/\.md$/)
    expect(unsafe).not.toMatch(/[<>:"/\\|?*\u0000-\u001f]/)
    expect(unsafe).not.toMatch(/^\./)
    expect(chatExportFilename({ id: 'safe-id', title: '...' })).toBe('Chat-safe-id.md')
    expect(chatExportFilename({ id: 'id', title: 'CON' })).toBe('Chat-CON.md')
    expect(chatExportFilename({ id: 'id', title: 'Report.md' })).toBe('Report.md')
  })

  it('preserves Unicode titles while limiting the actual filename byte length', () => {
    expect(chatExportFilename({ id: 'id', title: 'मेरी बातचीत 😀' })).toBe('मेरी बातचीत 😀.md')
    const filename = chatExportFilename({ id: 'id', title: '😀'.repeat(1000) })
    expect(Buffer.byteLength(filename, 'utf8')).toBeLessThanOrEqual(190)
    expect(filename).not.toContain('\ufffd')
    expect(filename).toMatch(/\.md$/)
  })
})

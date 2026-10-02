import { useMemo, useState } from 'react'
import hljs from 'highlight.js/lib/common'
import { parseUnifiedDiff, splitDiffLines, type DiffLine } from '@shared/diff'
import { languageOf } from '../lib/format'

function Code({ line, path }: { line?: DiffLine; path: string }) {
  const html = useMemo(() => {
    if (!line || line.kind === 'note' || line.text.length > 1500) return undefined
    const language = languageOf(path)
    try { return language && hljs.getLanguage(language) ? hljs.highlight(line.text, { language }).value : undefined } catch { return undefined }
  }, [line?.text, line?.kind, path])
  return html ? <code dangerouslySetInnerHTML={{ __html: html }} /> : <code>{line?.text || ' '}</code>
}

export function DiffViewer({ diff, path, oldPath, mode = 'unified' }: { diff: string; path?: string; oldPath?: string; mode?: 'unified' | 'split' }) {
  const files = useMemo(() => parseUnifiedDiff(diff, path), [diff, path])
  const [expanded, setExpanded] = useState(false)
  if (!files.length) return <div className="panel-note">No text changes in this patch.</div>
  return (
    <div className={`review-diff ${mode}`}>
      {files.map((file, fileIndex) => {
        let shown = 0
        const caption = files.length === 1 && path ? path : file.path
        const previous = files.length === 1 && oldPath ? oldPath : file.oldPath !== file.path ? file.oldPath : undefined
        const total = file.hunks.reduce((n, hunk) => n + hunk.lines.length, 0)
        return (
          <section key={`${file.path}-${fileIndex}`} className="review-diff-file">
            <div className="review-file-caption">
              <span>{previous && previous !== caption ? `${previous} → ` : ''}{caption}</span>
              <span className="change-stat"><span className="add">+{file.added}</span> <span className="del">−{file.removed}</span></span>
            </div>
            {file.binary ? <div className="panel-note">Binary file changed. Open the file to view its contents.</div> : null}
            {!file.hunks.length && !file.binary && <div className="panel-note">{file.metadata.filter((line) => !/^={3,}$|^Index: /.test(line)).join('\n') || `File ${file.status}; no content changes.`}</div>}
            {mode === 'split' && file.hunks.length > 0 && <div className="review-split-labels"><span>Before · removed</span><span>After · added</span></div>}
            {file.hunks.map((hunk, index) => {
              const lines = expanded ? hunk.lines : hunk.lines.slice(0, Math.max(0, 2000 - shown))
              shown += hunk.lines.length
              if (!lines.length) return null
              return (
                <div key={index} className="review-hunk">
                  <div className="review-hunk-head">{hunk.header}</div>
                  {mode === 'split' ? splitDiffLines(lines).map((row, rowIndex) => (
                    <div key={rowIndex} className="review-split-row">
                      {[row.left, row.right].map((line, side) => (
                        <div key={side} className={`review-line ${line?.kind ?? 'empty'}`}>
                          <span className="review-line-number">{side === 0 ? line?.oldLine : line?.newLine}</span>
                          <span className="review-sign">{line?.kind === 'remove' ? '−' : line?.kind === 'add' ? '+' : ''}</span>
                          <Code line={line} path={file.path} />
                        </div>
                      ))}
                    </div>
                  )) : lines.map((line, lineIndex) => (
                    <div key={lineIndex} className={`review-line ${line.kind}`}>
                      <span className="review-line-number">{line.oldLine}</span>
                      <span className="review-line-number">{line.newLine}</span>
                      <span className="review-sign">{line.kind === 'remove' ? '−' : line.kind === 'add' ? '+' : ''}</span>
                      <Code line={line} path={file.path} />
                    </div>
                  ))}
                </div>
              )
            })}
            {!expanded && total > 2000 && <button className="btn review-expand" onClick={() => setExpanded(true)}>Show all {total.toLocaleString()} lines</button>}
          </section>
        )
      })}
    </div>
  )
}

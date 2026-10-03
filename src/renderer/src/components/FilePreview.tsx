import { useEffect, useMemo, useRef, useState } from 'react'
import hljs from 'highlight.js/lib/common'
import type { FileContent, Room } from '@shared/types'
import { basename, languageOf, relative } from '../lib/format'
import { act, useApp, type PreviewTarget } from '../store'
import { Icon } from './Icon'
import { Markdown } from './Markdown'

export function FilePreview({ room, target }: { room: Room; target: PreviewTarget }) {
  const { path, line, column, fragment, memberId } = target
  const parent = path.replace(/[\\/][^\\/]+$/, '')
  const version = useApp((s) => s.dirVersion[parent] ?? 0)
  const platform = useApp((s) => s.platform)
  const index = useApp((s) => s.previewIndex)
  const count = useApp((s) => s.previewHistory.length)
  const navigate = useApp((s) => s.navigatePreview)
  const [file, setFile] = useState<FileContent>()
  const [error, setError] = useState<string>()
  const [ready, setReady] = useState(false)
  const [reload, setReload] = useState(0)
  const [source, setSource] = useState(!!line)
  const body = useRef<HTMLDivElement>(null)
  const isImage = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i.test(path)
  const isPdf = /\.pdf$/i.test(path)
  const isMd = /\.(md|markdown)$/i.test(path)
  const mediaUrl = `iface://file/${encodeURIComponent(path)}?v=${version}-${reload}`

  useEffect(() => {
    // Preview reads report actionable errors; a missing watch must not reject on unmount.
    void window.iface.watchDir(parent).catch(() => {})
    return () => { void window.iface.unwatchDir(parent).catch(() => {}) }
  }, [parent])

  useEffect(() => {
    let live = true
    setFile(undefined)
    setReady(false)
    setError(undefined)
    void (async () => {
      await window.iface.resolveFileLink(room.id, path, memberId)
      const content = !isImage && !isPdf && !target.isDirectory ? await window.iface.readFile(path) : undefined
      if (live) { setFile(content); setReady(true) }
    })().catch((err: Error) => live && setError(err.message.replace(/^Error invoking remote method 'api': (Error: )?/, '')))
    return () => { live = false }
  }, [room.id, path, memberId, version, reload, isImage, isPdf, target.isDirectory])

  const html = useMemo(() => {
    if (!file || file.binary || file.content.length > 300000) return undefined
    const lang = languageOf(path)
    try { return lang && hljs.getLanguage(lang) ? hljs.highlight(file.content, { language: lang }).value : undefined } catch { return undefined }
  }, [file, path])
  const lineCount = file?.content.split('\n').length ?? 0
  const selectedLine = line && line <= lineCount ? line : undefined
  const numbers = useMemo(() => Array.from({ length: lineCount }, (_, i) => i + 1).join('\n'), [lineCount])

  useEffect(() => {
    if (!ready || !body.current) return
    if (isMd && !source && fragment) {
      let id = fragment
      try { id = decodeURIComponent(id) } catch { /* use the literal fragment */ }
      Array.from(body.current.querySelectorAll('[id]')).find((element) => element.id === id)?.scrollIntoView({ block: 'start' })
    } else if (selectedLine) {
      body.current.scrollTop = Math.max(0, 14 + (selectedLine - 1) * 20 - 60)
      if (column) body.current.scrollLeft = Math.max(0, (column - 1) * 7.2 - 60)
    }
  }, [ready, source, fragment, selectedLine, column, isMd])

  const open = (): void => { void act(() => window.iface.openPath(path)) }
  return (
    <section className="preview" aria-label={`Preview ${basename(path)}`}>
      <div className="preview-head">
        <button className="icon-btn" disabled={index <= 0} onClick={() => navigate(index - 1)} title="Previous document"><Icon name="back" size={14} /></button>
        <button className="icon-btn" disabled={index >= count - 1} onClick={() => navigate(index + 1)} title="Next document"><Icon name="arrowRight" size={14} /></button>
        <span className="preview-path" title={path}>{basename(path)}</span>
        <button className="icon-btn" title="Refresh document" onClick={() => setReload((value) => value + 1)}><Icon name="refresh" size={14} /></button>
        {isMd && <button className="btn tiny" onClick={() => setSource(!source)}>{source ? 'Rendered' : 'Source'}</button>}
        <button className="icon-btn" title="Open in default app" onClick={open}><Icon name="external" size={14} /></button>
        <button className="icon-btn" title={platform === 'darwin' ? 'Reveal in Finder' : 'Reveal in file manager'} onClick={() => void act(() => window.iface.revealPath(path))}><Icon name="folderOpen" size={14} /></button>
      </div>
      <div className="preview-location" title={path}>{relative(path, room.folder)}{line ? ` · Line ${line}${column ? `:${column}` : ''}` : ''}</div>
      <div className={`preview-body ${isPdf ? 'preview-pdf-body' : ''}`} ref={body}>
        {error ? <div className="panel-empty" role="alert">{error}</div> : !ready ? <div className="panel-empty">Loading…</div> : target.isDirectory ? (
          <div className="panel-empty">This link points to a folder.<br /><button className="btn" onClick={open}>Open folder</button></div>
        ) : isPdf ? (
          <iframe className="preview-pdf" title={`PDF: ${basename(path)}`} src={`${mediaUrl}#${fragment ?? 'toolbar=1&navpanes=1'}`} />
        ) : isImage ? (
          <img className="preview-img" src={mediaUrl} alt={basename(path)} onError={() => setError('This image could not be displayed. Try refreshing or opening it in its default app.')} />
        ) : file?.binary ? (
          <div className="panel-empty">This file needs its own app ({Math.ceil(file.size / 1024)} KB).<br /><button className="btn" onClick={open}>Open in default app</button></div>
        ) : isMd && !source ? (
          <div className="preview-md"><Markdown text={file?.content ?? ''} roomId={room.id} memberId={memberId} fromFile={path} /></div>
        ) : (
          <div className="preview-source">
            {selectedLine && <div className="preview-selected-line" style={{ top: 14 + (selectedLine - 1) * 20 }} aria-hidden="true" />}
            <pre className="preview-line-numbers" aria-hidden="true">{numbers}</pre>
            <pre className="preview-code">{html ? <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} /> : <code>{file?.content}</code>}</pre>
          </div>
        )}
        {file?.truncated && <div className="panel-note">Showing the first 512 KB. Open in the default app to read the rest.</div>}
        {line && file && line > lineCount && <div className="panel-note">Line {line} is outside this preview.</div>}
      </div>
    </section>
  )
}

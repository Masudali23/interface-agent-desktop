import { useState } from 'react'
import { diffLines } from 'diff'
import type { Block } from '@shared/types'
import { relative, str, toolLabel, toolSummary, TOOL_VERB } from '../lib/format'
import { planInputItems } from '../lib/timeline'
import { Icon, type IconName } from './Icon'
import { useApp } from '../store'
import { codexFileChange, editedPaths } from '@shared/changes'
import { DiffViewer } from './DiffViewer'
import { PlanList } from './PlanCard'

type ToolBlock = Extract<Block, { kind: 'tool' }>
type Input = Record<string, unknown>

const TOOL_ICON: Record<string, IconName> = {
  Bash: 'terminal',
  Shell: 'terminal',
  Read: 'eye',
  Edit: 'pencil',
  MultiEdit: 'pencil',
  Write: 'pencil',
  NotebookEdit: 'pencil',
  'Edit files': 'pencil',
  Glob: 'search',
  Grep: 'search',
  WebFetch: 'globe',
  WebSearch: 'globe',
  'Web search': 'globe',
  TodoWrite: 'tasks',
  TaskCreate: 'tasks',
  TaskUpdate: 'tasks',
  TaskList: 'tasks',
  TaskGet: 'tasks',
  ToolSearch: 'search',
  Plan: 'tasks',
  Task: 'bolt',
  Agent: 'bolt'
}

export function toolIcon(name: string): IconName {
  return TOOL_ICON[name] ?? 'bolt'
}

export function DiffView({ before, after, path }: { before: string; after: string; path?: string }) {
  const parts = diffLines(before, after)
  let added = 0
  let removed = 0
  for (const p of parts) {
    const n = p.count ?? p.value.split('\n').length - 1
    if (p.added) added += n
    if (p.removed) removed += n
  }
  return (
    <div className="diff">
      {path && (
        <div className="diff-head">
          <span>{path}</span>
          <span className="diff-stat">
            <span className="add">+{added}</span> <span className="del">−{removed}</span>
          </span>
        </div>
      )}
      <pre className="diff-body">
        {parts.map((p, i) =>
          p.value
            .replace(/\n$/, '')
            .split('\n')
            .map((line, j) => (
              <div key={`${i}-${j}`} className={p.added ? 'line add' : p.removed ? 'line del' : 'line'}>
                <span className="sign">{p.added ? '+' : p.removed ? '−' : ' '}</span>
                {line || ' '}
              </div>
            ))
        )}
      </pre>
    </div>
  )
}

/** Renders a unified diff (git / Codex format). */
export function UnifiedDiff({ diff, path, oldPath }: { diff: string; path?: string; oldPath?: string }) {
  return <div className="diff"><DiffViewer diff={diff} path={path} oldPath={oldPath} /></div>
}

export function ToolDetails({ name, input, root }: { name: string; input: unknown; root: string }) {
  const i = (input ?? {}) as Input
  const path = relative(str(i.file_path ?? i.notebook_path), root)
  switch (name) {
    case 'Edit':
      return <DiffView before={str(i.old_string)} after={str(i.new_string)} path={path} />
    case 'MultiEdit':
      return (
        <>
          {(Array.isArray(i.edits) ? (i.edits as Input[]) : []).map((e, k) => (
            <DiffView key={k} before={str(e.old_string)} after={str(e.new_string)} path={k === 0 ? path : undefined} />
          ))}
        </>
      )
    case 'Write': {
      const content = str(i.content)
      const lines = content.split('\n')
      return <DiffView before="" after={lines.length > 400 ? `${lines.slice(0, 400).join('\n')}\n…` : content} path={path} />
    }
    case 'Bash':
    case 'Shell':
      return <pre className="cmd">$ {str(i.command)}</pre>
    case 'command':
      return (
        <>
          <pre className="cmd">$ {str(i.command)}</pre>
          {i.cwd ? <div className="hint">in {relative(str(i.cwd), root) || str(i.cwd)}</div> : null}
        </>
      )
    case 'file change':
      return <ToolDetails name="Edit files" input={i} root={root} />
    case 'TodoWrite':
    case 'Plan':
      return <PlanList items={planInputItems(name, i)} />
    case 'Edit files':
      return (
        <>
          {(Array.isArray(i.changes) ? i.changes : []).map((raw, k) => {
            const change = codexFileChange(raw)
            if (!change) return null
            const path = relative(change.path, root)
            return change.diff ? <UnifiedDiff key={k} diff={change.diff} path={path} oldPath={change.oldPath ? relative(change.oldPath, root) : undefined} /> : (
              <div key={k} className="changes-list">
                <span className={`kind kind-${change.kind}`}>{change.kind}</span> {change.oldPath ? `${relative(change.oldPath, root)} → ` : ''}{path}
              </div>
            )
          })}
        </>
      )
    default:
      return Object.keys(i).length ? <pre className="json">{JSON.stringify(i, null, 2)}</pre> : null
  }
}

/** One step inside an expanded activity row; opens to the call's details. */
export function ToolCard({ block, root, memberId, messageId }: { block: ToolBlock; root: string; memberId?: string; messageId?: string }) {
  const [open, setOpen] = useState(false)
  const openChange = useApp((s) => s.openChange)
  const paths = editedPaths(block)
  const verb = TOOL_VERB[block.name] ?? toolLabel(block.name)
  const summary = toolSummary(block.name, block.input, root)
  const showOutput = block.output && !['Edit', 'MultiEdit', 'Write', 'TodoWrite', 'Edit files'].includes(block.name)
  return (
    <div className={`tx-step ${open ? 'open' : ''} ${block.status}`}>
      <button className="tx-step-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name={toolIcon(block.name)} size={13} className="tx-step-icon" />
        <span className="tx-step-verb">{verb}</span>
        <span className="tx-step-summary">{summary}</span>
        <span className="tx-step-state">
          {block.status === 'running' ? <span className="spinner small" /> : block.status === 'error' ? <Icon name="alert" size={13} /> : null}
        </span>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} className="tx-step-chevron" />
      </button>
      {open && (
        <div className="tx-step-body tool-body">
          {paths.length > 0 && <div className="tool-review-actions">{paths.map((path) => <button className="btn tiny" key={path} onClick={() => openChange(path, memberId, messageId)}><Icon name="diff" size={12} /> Review {relative(path, root)}</button>)}</div>}
          <ToolDetails name={block.name} input={block.input} root={root} />
          {showOutput && <pre className={`tool-output ${block.isError ? 'error' : ''}`}>{block.output}</pre>}
          {!showOutput && block.isError && block.output && <pre className="tool-output error">{block.output}</pre>}
        </div>
      )}
    </div>
  )
}

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { Member, ModelOption, Room } from '@shared/types'
import { CODEX_MODES, effortLabel, PERMISSION_MODES } from '../lib/options'
import { act, useApp, EMPTY } from '../store'
import { AgentMark, Icon } from './Icon'

/** A small menu that opens above (or below) its button and closes on an outside click or Escape. */
export function Popover({ button, children, className = '', align = 'left' }: { button: (open: boolean, toggle: () => void) => ReactNode; children: (close: () => void) => ReactNode; className?: string; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false)
  const [place, setPlace] = useState<CSSProperties | undefined>()
  const ref = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onResize = (): void => setOpen(false)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onResize)
    }
  }, [open])
  // Keep the whole menu on screen: open towards the side with more room and limit its
  // height to that space, so no item (like the first models in a long list) is cut off.
  useLayoutEffect(() => {
    if (!open) {
      setPlace(undefined)
      return
    }
    const anchor = ref.current?.getBoundingClientRect()
    const menu = menuRef.current
    if (!anchor || !menu || place) return
    const margin = 8
    const gap = 6
    const above = anchor.top - gap - margin
    const below = window.innerHeight - anchor.bottom - gap - margin
    const height = menu.scrollHeight
    const prefersUp = menu.getBoundingClientRect().top < anchor.top
    const up = prefersUp ? height <= above || above >= below : !(height <= below || below >= above)
    const next: CSSProperties = up
      ? { top: 'auto', bottom: `calc(100% + ${gap}px)`, maxHeight: Math.max(120, above) }
      : { bottom: 'auto', top: `calc(100% + ${gap}px)`, maxHeight: Math.max(120, below) }
    const rect = menu.getBoundingClientRect()
    if (rect.right > window.innerWidth - margin) next.transform = `translateX(${Math.round(window.innerWidth - margin - rect.right)}px)`
    else if (rect.left < margin) next.transform = `translateX(${Math.round(margin - rect.left)}px)`
    setPlace(next)
  }, [open, place])
  return (
    <div className={`pop-anchor ${className}`} ref={ref}>
      {button(open, () => setOpen(!open))}
      {open && (
        <div ref={menuRef} className={`popover menu align-${align}`} style={place ?? { visibility: 'hidden' }}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}

function modelLabel(models: ModelOption[], id: string): string {
  if (!id) return models.find((m) => m.isDefault)?.label ?? 'Default'
  return models.find((m) => m.id === id)?.label ?? id
}

export function useMemberModels(member: Member): ModelOption[] {
  return useApp((s) => s.meta[member.accountId]?.models ?? EMPTY)
}

function update(room: Room, member: Member, patch: Partial<Member['settings']>): void {
  void act(() => window.iface.updateMember(room.id, member.id, patch))
}

/** Model picker, like the one in Claude desktop and the Codex app. */
export function ModelMenu({ room, member, compact = false }: { room: Room; member: Member; compact?: boolean }) {
  const models = useMemberModels(member)
  const s = member.settings
  const selected = models.find((m) => m.id === s.model) ?? models.find((m) => (s.model ? false : m.isDefault))
  const efforts = selected?.efforts ?? []
  return (
    <Popover
      button={(open, toggle) => (
        <button className={`pill-btn ${open ? 'on' : ''}`} onClick={toggle} title="Model and effort">
          {compact && <AgentMark provider={member.provider} color={member.color} size={14} />}
          <span>{modelLabel(models, s.model)}</span>
          {s.effort ? <span className="muted">· {effortLabel(s.effort)}</span> : null}
          <Icon name="chevronDown" size={11} />
        </button>
      )}
    >
      {(close) => (
        <div className="model-menu">
          <div className="menu-title">{member.name} · model</div>
          {models.length === 0 && <div className="menu-empty">Loading models… (sign in to this account if this stays empty)</div>}
          {models.map((m) => (
            <button
              key={m.id || 'default'}
              className={`menu-item ${(s.model || '') === m.id || (!s.model && m.isDefault) ? 'on' : ''}`}
              onClick={() => {
                update(room, member, { model: m.id, effort: m.efforts.includes(s.effort) ? s.effort : '' })
                close()
              }}
            >
              <span className="mi-label">{m.label}</span>
              {m.description && <span className="mi-desc">{m.description}</span>}
            </button>
          ))}
          {efforts.length > 0 && (
            <>
              <div className="menu-title">Effort</div>
              <div className="effort-row">
                {['', ...efforts].map((e) => (
                  <button key={e || 'default'} className={`chip ${s.effort === e ? 'on' : ''}`} onClick={() => update(room, member, { effort: e })}>
                    {e ? effortLabel(e) : 'Auto'}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </Popover>
  )
}

/** Permission mode (Claude) or sandbox mode (Codex). */
export function ModeMenu({ room, member }: { room: Room; member: Member }) {
  const options = member.provider === 'claude' ? PERMISSION_MODES : CODEX_MODES
  const value = member.provider === 'claude' ? member.settings.permissionMode : member.settings.codexMode
  const current = options.find((o) => o.value === value)
  const risky = value === 'bypassPermissions' || value === 'full'
  return (
    <Popover
      button={(open, toggle) => (
        <button className={`pill-btn ${open ? 'on' : ''} ${risky ? 'risky' : ''}`} onClick={toggle} title={current?.hint}>
          <Icon name="shield" size={12} />
          <span>{current?.label}</span>
          <Icon name="chevronDown" size={11} />
        </button>
      )}
    >
      {(close) => (
        <div className="model-menu">
          <div className="menu-title">{member.name} · {member.provider === 'claude' ? 'permissions' : 'sandbox'}</div>
          {options.map((o) => (
            <button
              key={o.value}
              className={`menu-item ${o.value === value ? 'on' : ''}`}
              onClick={() => {
                update(room, member, member.provider === 'claude' ? { permissionMode: o.value as Member['settings']['permissionMode'] } : { codexMode: o.value as Member['settings']['codexMode'] })
                close()
              }}
            >
              <span className="mi-label">{o.label}</span>
              <span className="mi-desc">{o.hint}</span>
            </button>
          ))}
        </div>
      )}
    </Popover>
  )
}

/** Circle that fills with how much of the agent's context window is used. */
export function ContextRing({ room, member }: { room: Room; member: Member }) {
  const ctx = useApp((s) => s.statuses[room.id]?.[member.id]?.context)
  if (!ctx) return null
  const pct = Math.min(100, Math.max(0, ctx.percent))
  const r = 7
  const c = 2 * Math.PI * r
  return (
    <span className="context-ring" title={`${member.name}: ${pct}% of context used (${Math.round(ctx.used / 1000)}k of ${Math.round(ctx.max / 1000)}k tokens)`}>
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <circle cx="9" cy="9" r={r} fill="none" stroke="var(--border-strong)" strokeWidth="2.2" />
        <circle
          cx="9"
          cy="9"
          r={r}
          fill="none"
          stroke={pct > 85 ? 'var(--danger)' : pct > 60 ? 'var(--warn)' : 'var(--text-2)'}
          strokeWidth="2.2"
          strokeDasharray={`${(pct / 100) * c} ${c}`}
          transform="rotate(-90 9 9)"
          strokeLinecap="round"
        />
      </svg>
      <span>{pct}%</span>
    </span>
  )
}

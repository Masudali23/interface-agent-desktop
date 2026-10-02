import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { terminalBus } from '../lib/bus'
import { act, useApp, EMPTY } from '../store'
import { AgentMark, Icon } from './Icon'
import { Popover } from './MemberControls'

interface Tab {
  id: string
  title: string
  exited?: boolean
}

function themeColors(): Record<string, string> {
  const css = getComputedStyle(document.documentElement)
  const v = (n: string): string => css.getPropertyValue(n).trim()
  return { background: v('--code-bg'), foreground: v('--text'), cursor: v('--text'), selectionBackground: v('--active') }
}

function TermView({ tab, active }: { tab: Tab; active: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | undefined>(undefined)
  const fitRef = useRef<FitAddon | undefined>(undefined)

  useEffect(() => {
    const term = new Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono'),
      fontSize: 12.5,
      cursorBlink: true,
      allowProposedApi: false,
      theme: themeColors(),
      scrollback: 5000
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host.current!)
    termRef.current = term
    fitRef.current = fit
    const off = terminalBus.listen(
      tab.id,
      (data) => term.write(data),
      (code) => term.write(`\r\n\x1b[2m[process exited with code ${code}]\x1b[0m\r\n`)
    )
    const sub = term.onData((d) => void window.iface.termWrite(tab.id, d))
    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
        void window.iface.termResize(tab.id, term.cols, term.rows)
      } catch {
        // hidden
      }
    })
    ro.observe(host.current!)
    return () => {
      ro.disconnect()
      sub.dispose()
      off()
      term.dispose()
    }
  }, [tab.id])

  useEffect(() => {
    if (!active) return
    requestAnimationFrame(() => {
      try {
        fitRef.current?.fit()
        termRef.current?.focus()
      } catch {
        // not visible yet
      }
    })
  }, [active])

  return <div className={`term-view ${active ? '' : 'hidden'}`} ref={host} />
}

export function TerminalPanel() {
  const open = useApp((s) => s.terminalOpen)
  const setTerminal = useApp((s) => s.setTerminal)
  const roomId = useApp((s) => s.currentRoomId ?? null)
  const accounts = useApp((s) => s.settings?.accounts ?? EMPTY)
  const [tabs, setTabs] = useState<Tab[]>([])
  const [active, setActive] = useState<string>()
  const [height, setHeight] = useState(280)

  const create = async (accountId: string | null): Promise<void> => {
    const t = await act(() => window.iface.termCreate(roomId, accountId, 100, 24))
    if (!t) return
    setTabs((cur) => [...cur, { id: t.id, title: t.title }])
    setActive(t.id)
  }

  useEffect(() => {
    if (open && !tabs.length) void create(null)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const close = (id: string): void => {
    void window.iface.termKill(id)
    setTabs((cur) => {
      const next = cur.filter((t) => t.id !== id)
      if (active === id) setActive(next[next.length - 1]?.id)
      if (!next.length) setTerminal(false)
      return next
    })
  }

  const startDrag = (e: React.MouseEvent): void => {
    const y0 = e.clientY
    const h0 = e.currentTarget.parentElement?.getBoundingClientRect().height ?? height
    const move = (ev: MouseEvent): void => setHeight(Math.max(140, Math.min(window.innerHeight * 0.4, h0 + (y0 - ev.clientY))))
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  return (
    <div className={`terminal-panel ${open ? '' : 'hidden'}`} style={{ height }}>
      <div className="term-resize" onMouseDown={startDrag} />
      <div className="term-tabs">
        {tabs.map((t) => (
          <span key={t.id} className={`term-tab ${t.id === active ? 'on' : ''}`} onClick={() => setActive(t.id)}>
            <Icon name="terminal" size={12} /> {t.title}
            <button
              className="icon-btn tiny"
              onClick={(e) => {
                e.stopPropagation()
                close(t.id)
              }}
              title="Close terminal"
            >
              <Icon name="x" size={10} />
            </button>
          </span>
        ))}
        <Popover
          button={(_, toggle) => (
            <button className="icon-btn tiny" onClick={toggle} title="New terminal">
              <Icon name="plus" size={13} />
            </button>
          )}
        >
          {(closeMenu) => (
            <div className="model-menu">
              <button
                className="menu-item row"
                onClick={() => {
                  closeMenu()
                  void create(null)
                }}
              >
                <Icon name="terminal" size={13} />
                <span className="mi-label">New terminal</span>
              </button>
              <div className="menu-title">Open as an account</div>
              {accounts.map((a) => (
                <button
                  key={a.id}
                  className="menu-item row"
                  onClick={() => {
                    closeMenu()
                    void create(a.id)
                  }}
                >
                  <AgentMark provider={a.provider} color={a.color} size={14} />
                  <span className="mi-label">{a.name}</span>
                  <span className="mi-desc">run `{a.provider === 'claude' ? 'claude' : 'codex'}` as this account</span>
                </button>
              ))}
            </div>
          )}
        </Popover>
        <span className="foot-spacer" />
        <button className="icon-btn tiny" onClick={() => setTerminal(false)} title="Hide terminal">
          <Icon name="chevronDown" size={13} />
        </button>
      </div>
      <div className="term-body">
        {tabs.map((t) => (
          <TermView key={t.id} tab={t} active={t.id === active && open} />
        ))}
      </div>
    </div>
  )
}

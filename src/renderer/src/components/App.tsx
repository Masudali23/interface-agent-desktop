import { useEffect } from 'react'
import { isSearchShortcut, shortcut } from '../lib/chrome'
import { useApp } from '../store'
import { Home } from './Home'
import { Icon } from './Icon'
import { NewSessionDialog } from './NewSession'
import { RightPanel } from './RightPanel'
import { RoomView } from './RoomView'
import { SearchPalette } from './SearchPalette'
import { SettingsDialog } from './SettingsDialog'
import { Sidebar } from './Sidebar'
import { TerminalPanel } from './TerminalPanel'

export function App() {
  const ready = useApp((s) => s.ready)
  const init = useApp((s) => s.init)
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  const setSidebar = useApp((s) => s.setSidebar)
  const room = useApp((s) => (s.currentRoomId ? s.roomData[s.currentRoomId] : undefined))
  const error = useApp((s) => s.error)
  const notice = useApp((s) => s.notice)
  const setError = useApp((s) => s.setError)
  const setNotice = useApp((s) => s.setNotice)
  const theme = useApp((s) => s.settings?.theme)
  const platform = useApp((s) => s.platform)
  const setSearchOpen = useApp((s) => s.setSearchOpen)

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    if (theme && theme !== 'system') document.documentElement.dataset.theme = theme
    else delete document.documentElement.dataset.theme
  }, [theme])

  useEffect(() => {
    const onError = (e: PromiseRejectionEvent): void => {
      const msg = e.reason instanceof Error ? e.reason.message : String(e.reason)
      setError(msg.replace(/^Error invoking remote method 'api': (Error: )?/, ''))
    }
    window.addEventListener('unhandledrejection', onError)
    return () => window.removeEventListener('unhandledrejection', onError)
  }, [setError])

  // ⌘K has no menu item (⌘N, ⌘B, ⌘, and Ctrl+` come from the app menu), so it is handled here.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const inTerminal = e.target instanceof Element && !!e.target.closest('.terminal-panel')
      if (!isSearchShortcut(e, platform, inTerminal)) return
      e.preventDefault()
      const s = useApp.getState()
      // setSearchOpen refuses to open over Settings or New session, which own the keyboard.
      setSearchOpen(!s.searchOpen)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [platform, setSearchOpen])

  if (!ready) return <div className="boot" />

  return (
    <div className={`app ${sidebarOpen ? 'has-sidebar' : 'no-sidebar'}`}>
      {sidebarOpen && <Sidebar />}
      <main className="main">
        {!sidebarOpen && (
          <button className="sidebar-toggle no-drag" onClick={() => setSidebar(true)} title={`Show sidebar (${shortcut(platform, 'B')})`} aria-label="Show sidebar">
            <Icon name="sidebar" size={16} />
          </button>
        )}
        <div className="main-content">{room ? <RoomView room={room} /> : <Home />}</div>
        <TerminalPanel />
      </main>
      {room && <RightPanel room={room} />}
      <SettingsDialog />
      <NewSessionDialog />
      <SearchPalette />
      {(error || notice) && (
        <div className={`toast ${error ? '' : 'info'}`} role="alert">
          <Icon name={error ? 'alert' : 'check'} size={14} />
          <span>{error ?? notice}</span>
          <button className="icon-btn" onClick={() => (error ? setError(undefined) : setNotice(undefined))}>
            <Icon name="x" size={13} />
          </button>
        </div>
      )}
    </div>
  )
}

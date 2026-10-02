import { useEffect } from 'react'
import { useApp } from '../store'
import { Home } from './Home'
import { Icon } from './Icon'
import { NewSessionDialog } from './NewSession'
import { RightPanel } from './RightPanel'
import { RoomView } from './RoomView'
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

  if (!ready) return <div className="boot" />

  return (
    <div className={`app ${sidebarOpen ? '' : 'no-sidebar'}`}>
      {sidebarOpen && <Sidebar />}
      <main className="main">
        <button className="sidebar-toggle no-drag" onClick={() => setSidebar(!sidebarOpen)} title="Toggle sidebar (Ctrl/Cmd+B)">
          <Icon name="sidebar" size={16} />
        </button>
        <div className="main-content">{room ? <RoomView room={room} /> : <Home />}</div>
        <TerminalPanel />
      </main>
      {room && <RightPanel room={room} />}
      <SettingsDialog />
      <NewSessionDialog />
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

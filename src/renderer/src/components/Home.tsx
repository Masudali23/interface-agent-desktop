import { useMemo } from 'react'
import type { AgentInstall, RoomKind } from '@shared/types'
import { projectGroups, shortcut } from '../lib/chrome'
import { ago, basename } from '../lib/format'
import { useApp, EMPTY } from '../store'
import { AgentMark, Icon } from './Icon'

const COPY: Record<RoomKind, { title: string; lead: string }> = {
  claude: { title: 'What should Claude Code work on?', lead: 'Pick a folder and work with Claude Code on your Claude plan, with any of your Claude accounts.' },
  codex: { title: 'What should Codex work on?', lead: 'Pick a folder and work with Codex on your ChatGPT plan, with any of your ChatGPT accounts.' },
  team: { title: 'You and your agents, in one room', lead: 'Several agents from any of your accounts share one conversation, hand work to each other and split the job.' }
}

function Install({ name, info, provider }: { name: string; info?: AgentInstall; provider: 'claude' | 'codex' }) {
  return (
    <div className={`home-install ${info?.found ? 'ok' : 'bad'}`}>
      <AgentMark provider={provider} color={provider === 'claude' ? '#c96442' : '#0f8f6f'} size={22} />
      <div className="home-install-text">
        <div className="home-install-name">{name}</div>
        <div className="home-install-detail">{info?.found ? `${info.version ?? 'Installed'}${info.detail ? ` · ${info.detail}` : ''}` : 'Not found. Install it, or set its path in Settings.'}</div>
      </div>
      <Icon name={info?.found ? 'checkCircle' : 'alert'} size={16} className="home-install-state" />
    </div>
  )
}

export function Home() {
  const mode = useApp((s) => s.mode)
  const platform = useApp((s) => s.platform)
  const agents = useApp((s) => s.agents)
  const projects = useApp((s) => s.settings?.projects ?? EMPTY)
  const rooms = useApp((s) => s.rooms)
  const openNewSession = useApp((s) => s.openNewSession)
  const addProject = useApp((s) => s.addProject)
  const copy = COPY[mode]
  const recent = useMemo(() => projectGroups(rooms, projects).map((g) => g.folder), [rooms, projects])
  const last = (folder: string): number | undefined => rooms.find((r) => r.folder === folder)?.updatedAt
  return (
    <div className="home drag">
      <div className="home-inner no-drag">
        <div className="home-marks">
          {mode !== 'codex' && <AgentMark provider="claude" color="#c96442" size={36} />}
          {mode !== 'claude' && <AgentMark provider="codex" color="#0f8f6f" size={36} />}
        </div>
        <h1 className="home-title">{copy.title}</h1>
        <p className="home-lead">{copy.lead}</p>
        <button className="home-start" onClick={() => openNewSession(recent[0], mode)}>
          <span className="home-start-icon"><Icon name="plus" size={18} /></span>
          <span className="home-start-text">
            <span className="home-start-label">New session</span>
            <span className="home-start-sub">{recent[0] ? `In ${basename(recent[0])} or another project` : 'Choose a folder to work in'}</span>
          </span>
          <kbd>{shortcut(platform, 'N')}</kbd>
        </button>
        {recent.length > 0 && (
          <div className="home-recent">
            <div className="home-section">Projects</div>
            {recent.slice(0, 6).map((f) => {
              const when = last(f)
              return (
                <button key={f} className="home-recent-row" onClick={() => openNewSession(f, mode)} title={`New session in ${f}`}>
                  <Icon name="folder" size={15} />
                  <span className="home-recent-name">{basename(f)}</span>
                  <span className="home-recent-path">{f}</span>
                  {when && <span className="home-recent-time">{ago(when)}</span>}
                  <Icon name="arrowRight" size={14} className="home-recent-go" />
                </button>
              )
            })}
            <button className="home-recent-row" onClick={() => void addProject()} title="Add a folder as a project">
              <Icon name="folderPlus" size={15} />
              <span className="home-recent-name">Add project…</span>
            </button>
          </div>
        )}
        <div className="home-installs">
          <Install name="Claude Code" info={agents?.claude} provider="claude" />
          <Install name="Codex" info={agents?.codex} provider="codex" />
        </div>
      </div>
    </div>
  )
}

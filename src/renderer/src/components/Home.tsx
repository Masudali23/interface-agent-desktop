import type { AgentInstall } from '@shared/types'
import { basename } from '../lib/format'
import { useApp, EMPTY } from '../store'
import { AgentMark, Icon } from './Icon'

const COPY = {
  claude: { title: 'Claude Code', lead: 'Work with Claude Code on a folder, with your Claude plan. Pick any of your Claude accounts.' },
  codex: { title: 'Codex', lead: 'Work with Codex on a folder, with your ChatGPT plan. Pick any of your ChatGPT accounts.' },
  team: { title: 'You and your agents, in one room', lead: 'Several agents from any of your accounts share one conversation, hand work to each other and split the job.' }
}

function Install({ name, info, provider }: { name: string; info?: AgentInstall; provider: 'claude' | 'codex' }) {
  return (
    <div className={`agent-card ${info?.found ? 'ok' : 'bad'}`}>
      <AgentMark provider={provider} color={provider === 'claude' ? '#c96442' : '#0f8f6f'} size={28} />
      <div>
        <div className="agent-card-name">{name}</div>
        <div className="agent-card-detail">{info?.found ? `${info.version ?? ''}${info.detail ? ` · ${info.detail}` : ''}` : 'Not found. Install it, or set its path in Settings.'}</div>
      </div>
      <Icon name={info?.found ? 'check' : 'alert'} size={16} className="agent-card-state" />
    </div>
  )
}

export function Home() {
  const mode = useApp((s) => s.mode)
  const agents = useApp((s) => s.agents)
  const recent = useApp((s) => s.settings?.recentFolders ?? EMPTY)
  const openNewSession = useApp((s) => s.openNewSession)
  const copy = COPY[mode]
  return (
    <div className="welcome drag">
      <div className="welcome-inner no-drag">
        <div className="welcome-marks">
          {mode !== 'codex' && <AgentMark provider="claude" color="#c96442" size={44} />}
          {mode !== 'claude' && <AgentMark provider="codex" color="#0f8f6f" size={44} />}
        </div>
        <h1>{copy.title}</h1>
        <p className="lead">{copy.lead}</p>
        <button className="btn primary big" onClick={() => openNewSession(undefined, mode)}>
          <Icon name="plus" size={16} /> New session
        </button>
        {recent.length > 0 && (
          <div className="recent">
            <div className="recent-title">Recent folders</div>
            {recent.slice(0, 6).map((f) => (
              <button key={f} className="recent-row" onClick={() => openNewSession(f, mode)} title={f}>
                <Icon name="folder" size={14} />
                <span className="recent-name">{basename(f)}</span>
                <span className="recent-path">{f}</span>
              </button>
            ))}
          </div>
        )}
        <div className="agent-cards">
          <Install name="Claude Code" info={agents?.claude} provider="claude" />
          <Install name="Codex" info={agents?.codex} provider="codex" />
        </div>
      </div>
    </div>
  )
}

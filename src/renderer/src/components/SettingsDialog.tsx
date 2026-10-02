import { useEffect, useState } from 'react'
import { ACCOUNT_COLORS, PROVIDER_LABEL, type Account, type AppSettings, type MemberSettings, type Provider } from '@shared/types'
import { ago } from '../lib/format'
import { CODEX_MODES, effortLabel, PERMISSION_MODES } from '../lib/options'
import { act, useApp, type SettingsTab, EMPTY } from '../store'
import { AgentMark, Icon } from './Icon'
import { UsageBars } from './Usage'

const TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: 'accounts', label: 'Accounts' },
  { id: 'defaults', label: 'Defaults' },
  { id: 'agents', label: 'Programs' },
  { id: 'app', label: 'App' }
]

function LoginBox({ account }: { account: Account }) {
  const login = useApp((s) => s.accountInfo[account.id]?.login)
  const [code, setCode] = useState('')
  if (!login || login.state === 'done') return null
  return (
    <div className={`login-box state-${login.state}`}>
      {login.state === 'starting' && <div>Starting sign-in…</div>}
      {login.state === 'waiting' && (
        <>
          <div>
            Finish signing in in your browser{login.url ? '. If it did not open, ' : '.'}
            {login.url && (
              <a href={login.url} onClick={(e) => (e.preventDefault(), void window.iface.openExternal(login.url!))}>
                open the sign-in page
              </a>
            )}
          </div>
          {login.userCode && (
            <div className="device-code">
              Enter this code on the page: <code>{login.userCode}</code>
            </div>
          )}
          {account.provider === 'claude' && (
            <div className="code-row">
              <input placeholder="Paste the code shown after you sign in" value={code} onChange={(e) => setCode(e.target.value)} />
              <button
                className="btn primary"
                disabled={!code.trim()}
                onClick={() => {
                  void act(() => window.iface.submitLoginCode(account.id, code))
                  setCode('')
                }}
              >
                Submit
              </button>
            </div>
          )}
          {login.message && <div className="hint">{login.message}</div>}
          <button className="btn tiny" onClick={() => void window.iface.cancelLogin(account.id)}>
            Cancel
          </button>
        </>
      )}
      {login.state === 'failed' && (
        <div className="warn-text">
          Sign-in did not finish{login.message ? `: ${login.message}` : ''}.{' '}
          <button className="btn tiny" onClick={() => void act(() => window.iface.loginAccount(account.id))}>
            Try again
          </button>
        </div>
      )}
    </div>
  )
}

function AccountCard({ account }: { account: Account }) {
  const info = useApp((s) => s.accountInfo[account.id])
  const [name, setName] = useState(account.name)
  const [handle, setHandle] = useState(account.handle)
  useEffect(() => {
    setName(account.name)
    setHandle(account.handle)
  }, [account.name, account.handle])
  const main = !account.home
  return (
    <div className="account-card">
      <div className="account-card-head">
        <AgentMark provider={account.provider} color={account.color} size={26} />
        <div className="account-fields">
          <input className="name-input" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name !== account.name && void window.iface.updateAccount(account.id, { name })} />
          <span className="handle-field">
            @
            <input value={handle} onChange={(e) => setHandle(e.target.value)} onBlur={() => handle !== account.handle && void window.iface.updateAccount(account.id, { handle })} />
          </span>
        </div>
        <div className="color-dots">
          {ACCOUNT_COLORS.map((c) => (
            <button key={c} className={`color-dot ${c === account.color ? 'on' : ''}`} style={{ background: c }} onClick={() => void window.iface.updateAccount(account.id, { color: c })} title="Colour" />
          ))}
        </div>
      </div>
      <div className="account-meta">
        <span>{PROVIDER_LABEL[account.provider]}</span>
        {main ? <span>main account ({account.provider === 'claude' ? '~/.claude' : '~/.codex'})</span> : <span title={account.home}>own folder</span>}
        {info?.loggedIn ? (
          <span className="tag ok">Signed in{info.email ? ` · ${info.email}` : ''}</span>
        ) : info?.loggedIn === false ? (
          <span className="tag warn">Not signed in</span>
        ) : (
          <span className="tag">Checking…</span>
        )}
        {info?.plan && <span className="plan">{info.plan}</span>}
        {info?.checkedAt && <span className="muted">updated {ago(info.checkedAt)}</span>}
      </div>
      <LoginBox account={account} />
      {info?.loggedIn && <UsageBars info={info} />}
      {info?.error && <div className="warn-text">{info.error}</div>}
      <div className="account-actions">
        {!info?.loggedIn ? (
          <>
            <button className="btn primary tiny" onClick={() => void act(() => window.iface.loginAccount(account.id))}>
              <Icon name="key" size={12} /> Sign in
            </button>
            {account.provider === 'codex' && (
              <button className="btn tiny" onClick={() => void act(() => window.iface.loginAccount(account.id, true))}>
                Sign in with a code
              </button>
            )}
          </>
        ) : (
          <button
            className="btn tiny"
            onClick={() => {
              if (confirm(`Sign out of ${account.name}? This signs ${PROVIDER_LABEL[account.provider]} out for this account everywhere on this computer${main ? ', including the terminal' : ''}.`)) {
                void act(() => window.iface.logoutAccount(account.id))
              }
            }}
          >
            <Icon name="logout" size={12} /> Sign out
          </button>
        )}
        <button className="btn tiny" onClick={() => void act(() => window.iface.refreshAccount(account.id))}>
          <Icon name="refresh" size={12} /> Refresh
        </button>
        {!main && (
          <>
            <button className="btn tiny" title="Link settings, skills and instructions and copy MCP servers from your main account" onClick={() => void act(() => window.iface.syncAccount(account.id), (r) => r)}>
              <Icon name="plug" size={12} /> Copy MCP and settings from main
            </button>
            <button
              className="btn tiny danger"
              onClick={() => {
                const wipe = confirm(`Remove ${account.name}?\n\nOK also deletes its sign-in and history folder from this computer. Cancel keeps the account.`)
                if (wipe) void act(() => window.iface.removeAccount(account.id, true))
              }}
            >
              <Icon name="trash" size={12} /> Remove
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function AddAccount({ provider }: { provider: Provider }) {
  const [name, setName] = useState('')
  const add = async (): Promise<void> => {
    const account = await act(() => window.iface.addAccount(provider, name || (provider === 'claude' ? 'Claude 2' : 'GPT 2')))
    setName('')
    if (account) void act(() => window.iface.loginAccount(account.id))
  }
  return (
    <div className="add-account">
      <AgentMark provider={provider} color={provider === 'claude' ? '#c96442' : '#0f8f6f'} size={18} />
      <input placeholder={provider === 'claude' ? 'Name, e.g. Claude Work' : 'Name, e.g. GPT Personal'} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void add()} />
      <button className="btn" onClick={() => void add()}>
        <Icon name="plus" size={12} /> Add {provider === 'claude' ? 'Claude' : 'ChatGPT'} account
      </button>
    </div>
  )
}

function Accounts() {
  const accounts = useApp((s) => s.settings?.accounts ?? EMPTY)
  return (
    <>
      <p className="hint">
        Each extra account has its own sign-in, kept by Claude Code or Codex itself in a separate folder. Your settings, skills, instructions and MCP
        servers are shared from your main account. Give each account a name and an @handle to mention it in team sessions.
      </p>
      {(['claude', 'codex'] as Provider[]).map((p) => (
        <section key={p} className="account-section">
          <h3>{p === 'claude' ? 'Claude accounts (Claude Code)' : 'ChatGPT accounts (Codex)'}</h3>
          {accounts
            .filter((a) => a.provider === p)
            .map((a) => (
              <AccountCard key={a.id} account={a} />
            ))}
          <AddAccount provider={p} />
        </section>
      ))}
    </>
  )
}

function DefaultsFor({ provider, value, onChange }: { provider: Provider; value: MemberSettings; onChange: (v: MemberSettings) => void }) {
  const meta = useApp((s) => s.meta)
  const accounts = useApp((s) => s.settings?.accounts ?? EMPTY)
  const first = accounts.find((a) => a.provider === provider)
  const models = first ? (meta[first.id]?.models ?? []) : []
  const efforts = models.find((m) => m.id === value.model)?.efforts ?? []
  return (
    <section>
      <h4>
        <AgentMark provider={provider} color={provider === 'claude' ? '#c96442' : '#0f8f6f'} size={18} /> {PROVIDER_LABEL[provider]}
      </h4>
      <label>
        Model
        <select value={value.model} onChange={(e) => onChange({ ...value, model: e.target.value, effort: '' })}>
          {!models.some((m) => m.id === '') && <option value="">Default</option>}
          {models.map((m) => (
            <option key={m.id || 'default'} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Effort
        <select value={value.effort} onChange={(e) => onChange({ ...value, effort: e.target.value })}>
          <option value="">Auto</option>
          {efforts.map((x) => (
            <option key={x} value={x}>
              {effortLabel(x)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {provider === 'claude' ? 'Permissions' : 'Sandbox'}
        <select
          value={provider === 'claude' ? value.permissionMode : value.codexMode}
          onChange={(e) =>
            onChange(provider === 'claude' ? { ...value, permissionMode: e.target.value as MemberSettings['permissionMode'] } : { ...value, codexMode: e.target.value as MemberSettings['codexMode'] })
          }
        >
          {(provider === 'claude' ? PERMISSION_MODES : CODEX_MODES).map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
    </section>
  )
}

function ProgramRow({ provider, path, onSave }: { provider: Provider; path: string; onSave: (v: string) => void }) {
  const info = useApp((s) => s.agents?.[provider])
  const [value, setValue] = useState(path)
  useEffect(() => setValue(path), [path])
  return (
    <div className="setting-agent">
      <div className="setting-agent-head">
        <AgentMark provider={provider} color={provider === 'claude' ? '#c96442' : '#0f8f6f'} size={20} />
        <b>{PROVIDER_LABEL[provider]}</b>
        <span className={`tag ${info?.found ? 'ok' : 'bad'}`}>{info?.found ? 'Found' : 'Not found'}</span>
      </div>
      <div className="setting-agent-detail">
        {info?.version && <span>{info.version}</span>}
        {info?.detail && <span>{info.detail}</span>}
      </div>
      <label>
        Program path
        <input value={value} placeholder={info?.path ?? 'Found automatically on PATH'} onChange={(e) => setValue(e.target.value)} onBlur={() => value !== path && onSave(value)} />
      </label>
    </div>
  )
}

export function SettingsDialog() {
  const open = useApp((s) => s.settingsOpen)
  const tab = useApp((s) => s.settingsTab)
  const openSettings = useApp((s) => s.openSettings)
  const close = useApp((s) => s.closeSettings)
  const settings = useApp((s) => s.settings)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  if (!open || !settings) return null
  const save = async (patch: Partial<AppSettings>): Promise<void> => {
    const res = await act(() => window.iface.saveSettings(patch))
    if (res) useApp.setState({ settings: res.settings, agents: res.agents })
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal settings" role="dialog" aria-label="Settings">
        <div className="modal-head">
          <h2>Settings</h2>
          <div className="settings-tabs">
            {TABS.map((t) => (
              <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => openSettings(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
          <button className="icon-btn" onClick={close} title="Close">
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modal-body">
          {tab === 'accounts' && <Accounts />}
          {tab === 'defaults' && (
            <>
              <p className="hint">New agents start with these settings. You can change them per agent at any time from the message box.</p>
              <div className="agent-settings">
                <DefaultsFor provider="claude" value={settings.defaults.claude} onChange={(v) => void save({ defaults: { ...settings.defaults, claude: v } })} />
                <DefaultsFor provider="codex" value={settings.defaults.codex} onChange={(v) => void save({ defaults: { ...settings.defaults, codex: v } })} />
                <section className="relay">
                  <label className="switch-row">
                    <input type="checkbox" checked={settings.defaults.autoRelay} onChange={(e) => void save({ defaults: { ...settings.defaults, autoRelay: e.target.checked } })} />
                    <span>
                      Automatic hand-offs in team sessions
                      <small>When an agent ends with "→ @other", that agent starts right away</small>
                    </span>
                  </label>
                  <label>
                    Max hand-offs per message
                    <input
                      type="number"
                      min={0}
                      max={30}
                      value={settings.defaults.maxHops}
                      onChange={(e) => void save({ defaults: { ...settings.defaults, maxHops: Math.max(0, Math.min(30, Number(e.target.value) || 0)) } })}
                    />
                  </label>
                </section>
              </div>
            </>
          )}
          {tab === 'agents' && (
            <>
              <p className="hint">
                The app runs the official <code>claude</code> and <code>codex</code> programs, signed in with your own plans. No API keys are used, and
                API key variables are removed from their environment so nothing is billed per use.
              </p>
              <ProgramRow provider="claude" path={settings.claudePath} onSave={(v) => void save({ claudePath: v })} />
              <ProgramRow provider="codex" path={settings.codexPath} onSave={(v) => void save({ codexPath: v })} />
              <button className="btn tiny" onClick={() => void act(async () => useApp.setState({ agents: await window.iface.checkAgents() }))}>
                <Icon name="refresh" size={12} /> Check again
              </button>
            </>
          )}
          {tab === 'app' && (
            <div className="agent-settings">
              <section>
                <label>
                  Theme
                  <select value={settings.theme} onChange={(e) => void save({ theme: e.target.value as AppSettings['theme'] })}>
                    <option value="system">Match system</option>
                    <option value="light">Light</option>
                    <option value="dark">Dark</option>
                  </select>
                </label>
                <label className="switch-row">
                  <input type="checkbox" checked={settings.notifications} onChange={(e) => void save({ notifications: e.target.checked })} />
                  <span>
                    Notifications
                    <small>When an agent replies or needs you while the app is in the background</small>
                  </span>
                </label>
              </section>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

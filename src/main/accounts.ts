// Named Claude and ChatGPT accounts.
//
// Each extra account gets its own config folder (CLAUDE_CONFIG_DIR or CODEX_HOME), so it
// has its own sign-in, which the official CLIs store themselves. Settings, skills,
// MCP servers and instructions are shared from your main account. Sign-in, usage limits,
// models and slash commands all come from the CLIs themselves.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  ACCOUNT_COLORS,
  type Account,
  type AccountInfo,
  type AppEvent,
  type ModelOption,
  type Provider,
  type RuntimeMeta
} from '@shared/types'
import { handleFrom } from '@shared/mentions'
import { claudeCommands, claudeModels } from './agents/claude'
import { ClaudeProcess } from './agents/claudeProcess'
import { CodexServer } from './agents/codexServer'
import { claudeLimits, codexLimits } from './agents/usage'
import { agentEnv, run } from './env'
import type { Store } from './store'

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

export interface AccountHost {
  emit(e: AppEvent): void
  binaries(): Partial<Record<Provider, string>>
  openUrl(url: string): void
  version: string
  dataDir: string
}

const CLAUDE_SHARED = ['settings.json', 'CLAUDE.md', 'skills', 'agents', 'commands', 'output-styles', 'plugins', 'keybindings.json']
const CODEX_SHARED = ['AGENTS.md', 'skills', 'prompts', 'rules']

function link(from: string, to: string): void {
  try {
    if (!existsSync(from)) return
    try {
      lstatSync(to)
      return // already there
    } catch {
      // not there yet
    }
    symlinkSync(from, to)
  } catch {
    // Can't link (for example on a different drive): leave it.
  }
}

export class AccountManager {
  readonly info = new Map<string, AccountInfo>()
  readonly meta = new Map<string, RuntimeMeta>()
  private servers = new Map<string, CodexServer>()
  private claudeLogins = new Map<string, ChildProcessWithoutNullStreams>()
  private codexLogins = new Map<string, string>()
  private refreshing = new Map<string, Promise<void>>()
  private timer?: NodeJS.Timeout

  constructor(
    private store: Store,
    private host: AccountHost
  ) {
    this.ensureDefaults()
  }

  list(): Account[] {
    return this.store.settings.accounts
  }

  get(id: string): Account | undefined {
    return this.list().find((a) => a.id === id)
  }

  firstOf(provider: Provider): Account | undefined {
    return this.list().find((a) => a.provider === provider)
  }

  env(account: Account): NodeJS.ProcessEnv {
    return agentEnv(account)
  }

  private save(accounts: Account[]): void {
    this.store.saveSettings({ accounts })
    this.host.emit({ type: 'settings', settings: this.store.settings })
  }

  private ensureDefaults(): void {
    const accounts = [...this.list()]
    let changed = false
    if (!accounts.some((a) => a.provider === 'claude')) {
      accounts.push({ id: 'claude-main', provider: 'claude', name: 'Claude', handle: 'claude', color: ACCOUNT_COLORS[0], createdAt: Date.now() })
      changed = true
    }
    if (!accounts.some((a) => a.provider === 'codex')) {
      accounts.push({ id: 'codex-main', provider: 'codex', name: 'GPT', handle: 'gpt', color: ACCOUNT_COLORS[1], createdAt: Date.now() })
      changed = true
    }
    if (changed) this.store.saveSettings({ accounts })
  }

  private uniqueHandle(wanted: string, exceptId?: string): string {
    const base = handleFrom(wanted)
    const taken = new Set(this.list().filter((a) => a.id !== exceptId).map((a) => a.handle))
    for (const reserved of ['user', 'both', 'all', 'everyone', 'team', 'you']) taken.add(reserved)
    if (!taken.has(base)) return base
    for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`
  }

  add(provider: Provider, name: string, handle?: string): Account {
    const id = `acc-${Date.now().toString(36)}${randomBytes(2).toString('hex')}`
    const home = join(this.host.dataDir, 'accounts', id)
    mkdirSync(home, { recursive: true, mode: 0o700 })
    const used = new Set(this.list().map((a) => a.color))
    const account: Account = {
      id,
      provider,
      name: name.trim() || (provider === 'claude' ? 'Claude' : 'GPT'),
      handle: this.uniqueHandle(handle || name),
      color: ACCOUNT_COLORS.find((c) => !used.has(c)) ?? ACCOUNT_COLORS[this.list().length % ACCOUNT_COLORS.length],
      home,
      createdAt: Date.now()
    }
    this.seed(account)
    this.save([...this.list(), account])
    this.info.set(id, { loggedIn: false, limits: [], notes: [] })
    this.host.emit({ type: 'account-info', accountId: id, info: this.info.get(id)! })
    return account
  }

  update(id: string, patch: Partial<Pick<Account, 'name' | 'handle' | 'color'>>): void {
    const accounts = this.list().map((a) =>
      a.id === id
        ? {
            ...a,
            ...(patch.name !== undefined ? { name: patch.name.trim() || a.name } : {}),
            ...(patch.handle !== undefined ? { handle: this.uniqueHandle(patch.handle || a.name, id) } : {}),
            ...(patch.color ? { color: patch.color } : {})
          }
        : a
    )
    this.save(accounts)
  }

  remove(id: string, deleteFiles: boolean): void {
    const account = this.get(id)
    if (!account) return
    if (!account.home) throw new Error('Your main account comes from ~/.claude or ~/.codex and cannot be removed here.')
    this.servers.get(id)?.dispose()
    this.servers.delete(id)
    this.cancelLogin(id)
    if (deleteFiles) rmSync(account.home, { recursive: true, force: true })
    this.info.delete(id)
    this.meta.delete(id)
    this.save(this.list().filter((a) => a.id !== id))
  }

  /** Shares settings, skills, instructions and MCP servers from the main account. */
  private seed(account: Account): void {
    if (!account.home) return
    const home = homedir()
    if (account.provider === 'claude') {
      const main = join(home, '.claude')
      for (const name of CLAUDE_SHARED) link(join(main, name), join(account.home, name))
      this.copyClaudeMcp(account.home, false)
    } else {
      const main = join(home, '.codex')
      for (const name of CODEX_SHARED) link(join(main, name), join(account.home, name))
      const config = join(main, 'config.toml')
      if (existsSync(config) && !existsSync(join(account.home, 'config.toml'))) copyFileSync(config, join(account.home, 'config.toml'))
    }
  }

  private copyClaudeMcp(target: string, overwrite: boolean): number {
    try {
      const main = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8'))
      const servers = main.mcpServers ?? {}
      const file = join(target, '.claude.json')
      const current = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
      if (current.mcpServers && !overwrite) return 0
      current.mcpServers = { ...(overwrite ? {} : current.mcpServers), ...servers }
      writeFileSync(file, JSON.stringify(current, null, 2), { mode: 0o600 })
      return Object.keys(servers).length
    } catch {
      return 0
    }
  }

  sync(id: string): string {
    const account = this.get(id)
    if (!account?.home) return 'Your main account is the source, nothing to copy.'
    this.seed(account)
    if (account.provider === 'claude') {
      const n = this.copyClaudeMcp(account.home, true)
      return `Linked your Claude settings, skills and instructions, and copied ${n} MCP server${n === 1 ? '' : 's'}.`
    }
    const main = join(homedir(), '.codex', 'config.toml')
    if (existsSync(main)) copyFileSync(main, join(account.home, 'config.toml'))
    this.servers.get(id)?.dispose()
    this.servers.delete(id)
    return 'Copied your Codex config (MCP servers, features) and linked AGENTS.md and skills.'
  }

  // ---------- live info ----------

  private setInfo(id: string, patch: Partial<AccountInfo>): void {
    const cur = this.info.get(id) ?? { limits: [], notes: [] }
    let limits = cur.limits
    if (patch.limits) {
      // Merge by id so quick updates (after a turn) don't drop the other windows.
      const map = new Map(cur.limits.map((l) => [l.id, l]))
      for (const l of patch.limits) map.set(l.id, { ...map.get(l.id), ...l })
      limits = patch.notes ? patch.limits : [...map.values()]
    }
    const next: AccountInfo = { ...cur, ...patch, limits, notes: patch.notes ?? cur.notes }
    this.info.set(id, next)
    this.host.emit({ type: 'account-info', accountId: id, info: next })
  }

  /** Called by agent connectors when the harness reports usage, models or the signed-in account. */
  fromAgent(id: string, info: Partial<AccountInfo>): void {
    this.setInfo(id, info)
  }

  setMeta(id: string, meta: Partial<RuntimeMeta>): void {
    const cur = this.meta.get(id) ?? { models: [], commands: [] }
    const next: RuntimeMeta = {
      models: meta.models?.length ? meta.models : cur.models,
      commands: meta.commands?.length ? meta.commands : cur.commands
    }
    this.meta.set(id, next)
    this.host.emit({ type: 'meta', accountId: id, meta: next })
  }

  defaultModel(id: string): string | undefined {
    return this.meta.get(id)?.models.find((m) => m.isDefault && m.id)?.id
  }

  refresh(id: string): Promise<void> {
    const existing = this.refreshing.get(id)
    if (existing) return existing
    const p = this.doRefresh(id).finally(() => this.refreshing.delete(id))
    this.refreshing.set(id, p)
    return p
  }

  refreshAll(): void {
    this.list().forEach((a, i) => setTimeout(() => void this.refresh(a.id), i * 700))
    clearInterval(this.timer)
    this.timer = setInterval(() => this.list().forEach((a) => void this.refresh(a.id)), 10 * 60 * 1000)
  }

  private async doRefresh(id: string): Promise<void> {
    const account = this.get(id)
    if (!account) return
    try {
      if (account.provider === 'claude') await this.refreshClaude(account)
      else await this.refreshCodex(account)
    } catch (err) {
      this.setInfo(id, { error: err instanceof Error ? err.message : String(err), checkedAt: Date.now() })
    }
  }

  private async refreshClaude(account: Account): Promise<void> {
    const bin = this.host.binaries().claude
    if (!bin) throw new Error('Claude Code is not installed')
    const env = this.env(account)
    const status = await run(bin, ['auth', 'status'], { env })
    let auth: Json = {}
    try {
      auth = JSON.parse(status.stdout)
    } catch {
      // older versions print text
    }
    if (!auth.loggedIn) {
      this.setInfo(account.id, { loggedIn: false, email: undefined, plan: undefined, limits: [], notes: [], checkedAt: Date.now(), error: undefined })
      return
    }
    const proc = new ClaudeProcess({ binary: bin, cwd: homedir(), env, args: ['--no-session-persistence'] })
    try {
      const init = await proc.request({ subtype: 'initialize' }, 30000)
      this.setMeta(account.id, { models: claudeModels(init.models), commands: claudeCommands(init.commands) })
      let usage: { limits: AccountInfo['limits']; notes: string[]; plan?: string } = { limits: [], notes: [] }
      try {
        // Right after start-up Claude Code may not have fetched the limits yet: ask again briefly.
        for (let attempt = 0; attempt < 4; attempt++) {
          usage = claudeLimits(await proc.request({ subtype: 'get_usage' }, 30000))
          if (usage.limits.length) break
          await new Promise((r) => setTimeout(r, 1500))
        }
      } catch {
        usage.notes = ['Usage limits are not available from this Claude Code version']
      }
      this.setInfo(account.id, {
        loggedIn: true,
        email: init.account?.email ?? auth.email,
        plan: init.account?.subscriptionType ?? usage.plan,
        org: init.account?.organization ?? auth.orgName,
        limits: usage.limits,
        notes: usage.notes,
        checkedAt: Date.now(),
        error: undefined
      })
    } finally {
      proc.end()
    }
  }

  codexServer(id: string): CodexServer | undefined {
    const account = this.get(id)
    const bin = this.host.binaries().codex
    if (!account || !bin) return undefined
    let server = this.servers.get(id)
    if (!server) {
      server = new CodexServer(bin, () => this.env(account), this.host.version)
      server.on('notification', (method: string, params: Json) => this.onCodexNotification(id, method, params))
      this.servers.set(id, server)
    }
    return server
  }

  private onCodexNotification(id: string, method: string, params: Json): void {
    if (method === 'account/rateLimits/updated') {
      const { limits, notes, plan } = codexLimits(params.rateLimits ? { rateLimits: params.rateLimits } : params)
      this.setInfo(id, { limits, ...(notes.length ? { notes } : {}), ...(plan ? { plan } : {}), checkedAt: Date.now() })
    } else if (method === 'account/login/completed') {
      this.codexLogins.delete(id)
      this.setInfo(id, {
        login: params.success ? { state: 'done' } : { state: 'failed', message: params.error ?? 'Sign-in did not finish' }
      })
      void this.refresh(id)
    } else if (method === 'account/updated') {
      void this.refresh(id)
    }
  }

  private async refreshCodex(account: Account): Promise<void> {
    const server = this.codexServer(account.id)
    if (!server) throw new Error('Codex is not installed')
    const acc = await server.request('account/read', { refreshToken: false })
    if (!acc.account) {
      this.setInfo(account.id, { loggedIn: false, email: undefined, plan: undefined, limits: [], notes: [], checkedAt: Date.now(), error: undefined })
      return
    }
    const [limitsRes, modelsRes] = await Promise.all([
      server.call('account/rateLimits/read', {}).catch(() => undefined),
      server.call('model/list', {}).catch(() => undefined)
    ])
    const models: ModelOption[] = (modelsRes?.data ?? [])
      .filter((m: Json) => !m.hidden)
      .map((m: Json) => ({
        id: String(m.id),
        label: String(m.displayName ?? m.id),
        description: m.description,
        efforts: (m.supportedReasoningEfforts ?? []).map((e: Json) => String(e.reasoningEffort)),
        defaultEffort: m.defaultReasoningEffort,
        isDefault: !!m.isDefault
      }))
    this.setMeta(account.id, {
      models,
      commands: [
        { name: 'review', description: 'Ask Codex to review the uncommitted changes' },
        { name: 'compact', description: 'Summarize the conversation to free up context' }
      ]
    })
    const usage = limitsRes ? codexLimits(limitsRes) : { limits: [], notes: ['Usage limits unavailable'], plan: undefined }
    this.setInfo(account.id, {
      loggedIn: true,
      email: acc.account.email ?? undefined,
      plan: acc.account.planType ?? usage.plan,
      limits: usage.limits,
      notes: usage.notes,
      checkedAt: Date.now(),
      error: undefined
    })
  }

  // ---------- sign in / out ----------

  async login(id: string, deviceCode = false): Promise<void> {
    const account = this.get(id)
    if (!account) return
    if (account.provider === 'codex') {
      const server = this.codexServer(id)
      if (!server) throw new Error('Codex is not installed')
      this.setInfo(id, { login: { state: 'starting' } })
      const r = await server.request('account/login/start', deviceCode ? { type: 'chatgptDeviceCode' } : { type: 'chatgpt' })
      this.codexLogins.set(id, r.loginId)
      if (r.authUrl) this.host.openUrl(r.authUrl)
      if (r.verificationUrl) this.host.openUrl(r.verificationUrl)
      this.setInfo(id, { login: { state: 'waiting', url: r.authUrl ?? r.verificationUrl, userCode: r.userCode } })
      return
    }
    const bin = this.host.binaries().claude
    if (!bin) throw new Error('Claude Code is not installed')
    this.cancelLogin(id)
    this.setInfo(id, { login: { state: 'starting' } })
    // `claude auth login` opens the browser itself; we also show the link and a box for the code.
    const proc = spawn(bin, ['auth', 'login', '--claudeai'], { env: this.env(account), stdio: ['pipe', 'pipe', 'pipe'] })
    this.claudeLogins.set(id, proc)
    let out = ''
    const onData = (d: Buffer): void => {
      out += d.toString()
      const url = /(https:\/\/\S+oauth\S+)/.exec(out)?.[1]
      const needsCode = /paste code/i.test(out)
      const cur = this.info.get(id)?.login
      if (url && (cur?.url !== url || cur?.needsCode !== needsCode)) {
        this.setInfo(id, { login: { state: 'waiting', url, needsCode } })
      }
    }
    proc.stdout.on('data', onData)
    proc.stderr.on('data', onData)
    proc.stdin.on('error', () => {})
    proc.on('exit', (code) => {
      if (this.claudeLogins.get(id) !== proc) return
      this.claudeLogins.delete(id)
      if (code === 0) {
        this.setInfo(id, { login: { state: 'done' } })
        void this.refresh(id)
      } else {
        const last = out.trim().split('\n').filter((l) => !/paste code/i.test(l)).pop()
        this.setInfo(id, { login: { state: 'failed', message: last || 'Sign-in was cancelled' } })
      }
    })
  }

  submitLoginCode(id: string, code: string): void {
    const proc = this.claudeLogins.get(id)
    if (!proc) throw new Error('No sign-in is waiting for a code.')
    proc.stdin.write(`${code.trim()}\n`)
    this.setInfo(id, { login: { ...this.info.get(id)?.login, state: 'waiting', needsCode: false, message: 'Checking the code…' } })
  }

  cancelLogin(id: string): void {
    const proc = this.claudeLogins.get(id)
    if (proc) {
      this.claudeLogins.delete(id)
      proc.kill('SIGTERM')
    }
    const loginId = this.codexLogins.get(id)
    if (loginId) {
      this.codexLogins.delete(id)
      this.servers.get(id)?.call('account/login/cancel', { loginId }).catch(() => {})
    }
    const cur = this.info.get(id)
    if (cur?.login && cur.login.state !== 'done') this.setInfo(id, { login: undefined })
  }

  async logout(id: string): Promise<void> {
    const account = this.get(id)
    if (!account) return
    if (account.provider === 'claude') {
      const bin = this.host.binaries().claude
      if (bin) await run(bin, ['auth', 'logout'], { env: this.env(account) })
    } else {
      await this.codexServer(id)?.request('account/logout', {})
    }
    this.setInfo(id, { loggedIn: false, limits: [], notes: [], email: undefined, plan: undefined, login: undefined })
  }

  dispose(): void {
    clearInterval(this.timer)
    for (const s of this.servers.values()) s.dispose()
    for (const p of this.claudeLogins.values()) p.kill('SIGTERM')
  }
}

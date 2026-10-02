import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  Notification,
  protocol,
  shell,
  ShareMenu,
  type MenuItemConstructorOptions
} from 'electron'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { IfaceApi } from '@shared/api'
import { parseMentions } from '@shared/mentions'
import type { AgentsInfo, AppEvent, Attachment, InitialState } from '@shared/types'
import { AccountManager } from './accounts'
import { chatClipboardMarkdown, chatShareFile, prepareChatExport, saveChatMarkdown, saveChatZip } from './chatExport'
import { chatExportFilename } from './exportMarkdown'
import { findBinary, initShellPath, run } from './env'
import { Files } from './files'
import { fileDiff, listFiles, status as gitStatus } from './git'
import { RoomManager } from './rooms'
import { UI_AUDIT_SCRIPT } from './selftestAudit'
import { Store } from './store'
import { Terminals } from './terminal'

const isMac = process.platform === 'darwin'

if (process.env.INTERFACE_USER_DATA) app.setPath('userData', resolve(process.env.INTERFACE_USER_DATA))

protocol.registerSchemesAsPrivileged([
  { scheme: 'iface', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

let win: BrowserWindow | undefined
let store: Store
let accounts: AccountManager
let rooms: RoomManager
let files: Files
let terminals: Terminals
let agents: AgentsInfo = { claude: { found: false }, codex: { found: false } }
let codexAppServer = false
let quitConfirmed = false
const shareMenus = new Set<ShareMenu>()

const e2eTerminal: string[] = []

function emit(e: AppEvent): void {
  if (process.env.INTERFACE_E2E && e.type === 'terminal-data') e2eTerminal.push(e.data)
  if (win && !win.isDestroyed()) win.webContents.send('event', e)
}

function notify(title: string, body: string, roomId?: string): void {
  if (!store.settings.notifications || !Notification.isSupported()) return
  if (BrowserWindow.getFocusedWindow()) return
  const n = new Notification({ title, body })
  n.on('click', () => {
    win?.show()
    win?.focus()
    if (roomId) emit({ type: 'open-room', roomId })
  })
  n.show()
}

// ---------- agent programs ----------

async function detectAgents(): Promise<AgentsInfo> {
  const claudePath = findBinary('claude', store.settings.claudePath)
  const codexPath = findBinary('codex', store.settings.codexPath)
  const [cv, xv, xa] = await Promise.all([
    claudePath ? run(claudePath, ['--version']) : undefined,
    codexPath ? run(codexPath, ['--version']) : undefined,
    codexPath ? run(codexPath, ['app-server', '--help']) : undefined
  ])
  codexAppServer = !!xa && xa.code === 0 && /app.server|Usage/i.test(xa.out)
  agents = {
    claude: { found: !!claudePath, path: claudePath, version: cv?.out.trim().split('\n')[0] },
    codex: {
      found: !!codexPath,
      path: codexPath,
      version: xv?.out.trim().split('\n')[0],
      detail: codexPath ? (codexAppServer ? 'app-server' : 'exec fallback (update Codex for approvals)') : undefined
    }
  }
  return agents
}

const binaries = (): { claude?: string; codex?: string } => ({ claude: agents.claude.path, codex: agents.codex.path })

// ---------- window ----------

function sendMenu(action: Extract<AppEvent, { type: 'menu' }>['action']): void {
  emit({ type: 'menu', action })
}

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New session', accelerator: 'CmdOrCtrl+N', click: () => sendMenu('new-room') },
        { label: 'Open folder…', accelerator: 'CmdOrCtrl+O', click: () => sendMenu('open-folder') },
        { type: 'separator' },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => sendMenu('settings') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Search messages', accelerator: 'CmdOrCtrl+Shift+F', click: () => sendMenu('search') },
        { label: 'Toggle sidebar', accelerator: 'CmdOrCtrl+B', click: () => sendMenu('toggle-sidebar') },
        { label: 'Toggle terminal', accelerator: 'Ctrl+`', click: () => sendMenu('toggle-terminal') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 620,
    show: false,
    title: 'Interface',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: isMac ? { x: 16, y: 16 } : undefined,
    autoHideMenuBar: !isMac,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1b1a' : '#f7f6f3',
    icon: isMac ? undefined : join(__dirname, '../../resources/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true
    }
  })
  w.on('ready-to-show', () => w.show())
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  w.webContents.on('will-navigate', (e, url) => {
    if (url === w.webContents.getURL()) return
    e.preventDefault()
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
  })
  if (process.env.ELECTRON_RENDERER_URL) void w.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void w.loadFile(join(__dirname, '../renderer/index.html'))
  w.on('closed', () => {
    if (win === w) win = undefined
  })
  return w
}

// ---------- API ----------

function insideRoots(path: string): boolean {
  const full = resolve(path)
  const contains = (root: string, file: string): boolean => {
    const rel = relative(root, file)
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  }
  try {
    const real = realpathSync(full)
    return rooms.roots().some((root) => {
      try { return contains(resolve(root), full) && contains(realpathSync(root), real) } catch { return false }
    })
  } catch { return false }
}

function roomCwd(roomId: string, memberId?: string): { cwd: string; base?: string } {
  const room = rooms.get(roomId)
  if (!room) throw new Error('Session not found')
  const member = memberId ? room.members.find((m) => m.id === memberId) : undefined
  if (member?.worktree) return { cwd: member.worktree.path, base: member.worktree.base }
  return { cwd: room.folder }
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json'
}

const api: IfaceApi = {
  getState: async (): Promise<InitialState> => ({
    platform: process.platform,
    settings: store.settings,
    rooms: store.list(),
    agents,
    accountInfo: Object.fromEntries(accounts.info),
    meta: Object.fromEntries(accounts.meta)
  }),
  checkAgents: async () => {
    const info = await detectAgents()
    accounts.refreshAll()
    return info
  },
  pickFolder: async () => {
    // Self-test only: answer the folder dialog without showing it.
    if (process.env.INTERFACE_E2E && process.env.INTERFACE_E2E_PICK) return process.env.INTERFACE_E2E_PICK
    const opts = { properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'> }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return res.canceled || !res.filePaths[0] ? null : res.filePaths[0]
  },

  createRoom: (input) => rooms.create(input),
  getRoom: async (roomId) => {
    const room = rooms.get(roomId)
    return room ? { room, statuses: rooms.statuses(roomId) } : null
  },
  renameRoom: async (roomId, title) => rooms.rename(roomId, title),
  pinRoom: async (roomId, pinned) => rooms.pin(roomId, pinned),
  deleteRoom: (roomId) => rooms.delete(roomId),
  updateRoom: async (roomId, patch) => rooms.updateRoom(roomId, patch),
  updateMember: async (roomId, memberId, patch) => rooms.updateMember(roomId, memberId, patch),
  addMember: (roomId, accountId) => rooms.addMember(roomId, accountId),
  removeMember: async (roomId, memberId) => rooms.removeMember(roomId, memberId),

  send: async (roomId, input) => rooms.send(roomId, input),
  stop: async (roomId, memberId) => rooms.stop(roomId, memberId),
  answer: async (roomId, messageId, blockId, decision) => rooms.answer(roomId, messageId, blockId, decision),
  continueHandoff: async (roomId, messageId) => rooms.continueHandoff(roomId, messageId),
  retry: (roomId, messageId) => rooms.retry(roomId, messageId),
  editMessage: (roomId, messageId, text, undoFiles) => rooms.editMessage(roomId, messageId, text, undoFiles),
  undoTurn: (roomId, messageId) => rooms.undoTurn(roomId, messageId),
  search: async (query) => store.search(query),
  exportChat: async (roomId, action) => {
    if (!['copy', 'markdown', 'zip', 'share'].includes(action)) throw new Error('Unknown export format')
    if (action === 'share' && !isMac) throw new Error('Use Copy Markdown or Save ZIP to share this chat.')
    const room = rooms.get(roomId)
    if (!room) throw new Error('Session not found')
    const snapshot = structuredClone(room)
    if (action === 'copy' || action === 'share') {
      const data = await prepareChatExport(snapshot)
      const missingAttachments = data.missing.size
      if (action === 'copy') {
        await clipboard.writeText(chatClipboardMarkdown(data))
        return { action: 'copied', missingAttachments }
      }
      const filePath = await chatShareFile(data, app.getPath('temp'))
      const menu = new ShareMenu({ filePaths: [filePath] })
      shareMenus.add(menu)
      menu.popup({ window: win, callback: () => shareMenus.delete(menu) })
      return { action: 'shared', path: filePath, missingAttachments }
    }
    const zip = action === 'zip'
    const filename = chatExportFilename(snapshot).replace(/\.md$/, zip ? '.zip' : '.md')
    const options: Electron.SaveDialogOptions = {
      title: zip ? 'Save complete chat ZIP' : 'Save chat as Markdown',
      defaultPath: join(app.getPath('downloads'), filename),
      filters: [{ name: zip ? 'Chat ZIP' : 'Markdown', extensions: [zip ? 'zip' : 'md'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation']
    }
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return { action: 'canceled', missingAttachments: 0 }
    const data = await prepareChatExport(snapshot)
    if (zip) await saveChatZip(data, result.filePath)
    else await saveChatMarkdown(data, result.filePath)
    return { action: 'saved', path: result.filePath, missingAttachments: data.missing.size }
  },
  refreshContext: (roomId, memberId) => rooms.refreshContext(roomId, memberId),
  mcpList: (roomId, memberId) => rooms.mcpList(roomId, memberId),
  mcpToggle: (roomId, memberId, name, enabled) => rooms.mcpToggle(roomId, memberId, name, enabled),
  mcpReconnect: (roomId, memberId, name) => rooms.mcpReconnect(roomId, memberId, name),

  addAccount: async (provider, name, handle) => accounts.add(provider, name, handle),
  updateAccount: async (accountId, patch) => accounts.update(accountId, patch),
  removeAccount: async (accountId, deleteFiles) => accounts.remove(accountId, deleteFiles),
  refreshAccount: (accountId) => accounts.refresh(accountId),
  loginAccount: (accountId, deviceCode) => accounts.login(accountId, deviceCode),
  submitLoginCode: async (accountId, code) => accounts.submitLoginCode(accountId, code),
  cancelLogin: async (accountId) => accounts.cancelLogin(accountId),
  logoutAccount: (accountId) => accounts.logout(accountId),
  syncAccount: async (accountId) => accounts.sync(accountId),

  gitStatus: async (roomId, memberId) => {
    const { cwd, base } = roomCwd(roomId, memberId)
    return gitStatus(cwd, base)
  },
  gitDiff: async (roomId, path, memberId, oldPath) => {
    const { cwd, base } = roomCwd(roomId, memberId)
    return fileDiff(cwd, path, base, oldPath)
  },
  mergeWorktree: (roomId, memberId) => rooms.mergeWorktree(roomId, memberId),
  discardWorktree: (roomId, memberId) => rooms.discardWorktree(roomId, memberId),

  listDir: (path, showHidden) => files.list(path, showHidden),
  readFile: (path) => files.read(path),
  watchDir: async (path) => files.watch(path),
  unwatchDir: async (path) => files.unwatch(path),
  searchFiles: async (roomId, query) => {
    const room = rooms.get(roomId)
    if (!room) return []
    const all = (await listFiles(room.folder)).length ? await listFiles(room.folder) : await files.quickList(room.folder)
    const q = query.toLowerCase()
    const scored = all
      .map((f) => {
        const lower = f.toLowerCase()
        const name = lower.split('/').pop() ?? lower
        const score = !q ? 1 : name.startsWith(q) ? 3 : name.includes(q) ? 2 : lower.includes(q) ? 1 : 0
        return { f, score }
      })
      .filter((x) => x.score > 0)
    scored.sort((a, b) => b.score - a.score || a.f.length - b.f.length)
    return scored.slice(0, 30).map((x) => x.f)
  },
  saveAttachment: async (roomId, name, bytes): Promise<Attachment> => {
    const dir = rooms.attachmentDir(roomId)
    if (!dir) throw new Error('Session not found')
    if (bytes.byteLength > 25 * 1024 * 1024) throw new Error('Attachments are limited to 25 MB.')
    mkdirSync(dir, { recursive: true })
    const safe = basename(name).replace(/[^\w.\- ]+/g, '_') || 'file'
    const file = join(dir, `${Date.now().toString(36)}-${safe}`)
    writeFileSync(file, bytes)
    return { name: safe, path: file, mime: MIME[extname(safe).toLowerCase()] ?? 'application/octet-stream', size: bytes.byteLength }
  },

  termCreate: async (roomId, accountId, cols, rows) => {
    const room = roomId ? rooms.get(roomId) : undefined
    const account = accountId ? accounts.get(accountId) : undefined
    return terminals.create(room?.folder, account, cols, rows)
  },
  termWrite: async (id, data) => terminals.write(id, data),
  termResize: async (id, cols, rows) => terminals.resize(id, cols, rows),
  termKill: async (id) => terminals.kill(id),

  saveSettings: async (patch) => {
    const pathsChanged =
      (patch.claudePath !== undefined && patch.claudePath !== store.settings.claudePath) ||
      (patch.codexPath !== undefined && patch.codexPath !== store.settings.codexPath)
    const settings = store.saveSettings(patch)
    if (patch.theme) nativeTheme.themeSource = patch.theme
    if (pathsChanged) await detectAgents()
    return { settings, agents }
  },
  openPath: async (path) => {
    if (insideRoots(path)) await shell.openPath(path)
  },
  revealPath: async (path) => {
    if (insideRoots(path)) shell.showItemInFolder(path)
  },
  openExternal: async (url) => {
    if (/^https?:\/\//.test(url)) await shell.openExternal(url)
  }
}

function registerIpc(): void {
  ipcMain.handle('api', async (_e, method: keyof IfaceApi, ...args: unknown[]) => {
    const fn = api[method] as (...a: unknown[]) => unknown
    if (typeof fn !== 'function') throw new Error(`Unknown method ${String(method)}`)
    return fn(...args)
  })
}

/**
 * iface://attachment/<roomId>/<file> serves a session's attachments to the UI.
 * iface://file/<encoded absolute path> serves images inside an open folder for the preview.
 */
function registerProtocol(): void {
  protocol.handle('iface', (req) => {
    const url = new URL(req.url)
    if (url.host === 'file') {
      const file = resolve(decodeURIComponent(url.pathname.slice(1)))
      if (!insideRoots(file)) return new Response('Forbidden', { status: 403 })
      return net.fetch(pathToFileURL(file).toString())
    }
    const [roomId, ...rest] = url.pathname.split('/').filter(Boolean)
    const dir = url.host === 'attachment' && roomId ? rooms.attachmentDir(roomId) : undefined
    if (!dir || !rest.length) return new Response('Not found', { status: 404 })
    const file = resolve(dir, decodeURIComponent(rest.join('/')))
    if (!file.startsWith(resolve(dir) + sep)) return new Response('Forbidden', { status: 403 })
    return net.fetch(pathToFileURL(file).toString())
  })
}

// ---------- end-to-end self test ----------
// INTERFACE_E2E=<config.json> runs a scripted session against the real CLIs,
// takes screenshots and quits. See README.

interface E2EStep {
  text?: string
  /** Send the text without waiting for the agents to finish. */
  noWait?: boolean
  action?: 'retry' | 'edit' | 'undo' | 'screenshot' | 'usage' | 'menu' | 'wait' | 'merge' | 'add-account' | 'terminal' | 'eval' | 'export-copy' | 'idle' | 'tick' | 'audit' | 'click' | 'type' | 'wheel' | 'member-settings'
  path?: string
}

interface E2EConfig {
  folder: string
  /** Start on the home screen without creating a session first. */
  noRoom?: boolean
  kind: 'claude' | 'codex' | 'team'
  accounts?: string[]
  isolation?: boolean
  memberSettings?: Partial<import('@shared/types').MemberSettings>
  steps: E2EStep[]
  screenshot: string
  approve?: boolean
  timeoutMs?: number
}

async function runE2E(configPath: string): Promise<void> {
  const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as E2EConfig
  const log: string[] = []
  const capture = async (path: string): Promise<void> => {
    const image = await win?.webContents.capturePage()
    if (image) writeFileSync(path, image.toPNG())
  }
  // A real mouse click through Chromium's input pipeline (hit-testing included) at the
  // centre of the first visible control whose text or title starts with `label`,
  // searching the open dialog first.
  const clickLabel = async (label: string): Promise<void> => {
    const box = await win?.webContents.executeJavaScript(`(() => {
      const modals = document.querySelectorAll('.modal')
      const scope = modals.length ? modals[modals.length - 1] : document
      const candidates = [...scope.querySelectorAll('button, [role=button], .chip, .kind-card, label')].filter((e) => e.getBoundingClientRect().width > 0)
      const wanted = ${JSON.stringify(label)}
      const el = candidates.find((e) => e.title === wanted || e.getAttribute('aria-label') === wanted)
        ?? candidates.find((e) => (e.innerText || '').trim() === wanted)
        ?? candidates.find((e) => (e.innerText || e.title || '').trim().startsWith(wanted))
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), disabled: !!el.disabled, what: el.tagName + '.' + String(el.className).split(' ')[0] }
    })()`)
    if (!box) {
      log.push(`click ${label}: not found`)
      return
    }
    win?.webContents.sendInputEvent({ type: 'mouseMove', x: box.x, y: box.y })
    win?.webContents.sendInputEvent({ type: 'mouseDown', x: box.x, y: box.y, button: 'left', clickCount: 1 })
    win?.webContents.sendInputEvent({ type: 'mouseUp', x: box.x, y: box.y, button: 'left', clickCount: 1 })
    await new Promise((r) => setTimeout(r, 800))
    log.push(`click ${label}: ${box.what} at ${box.x},${box.y}${box.disabled ? ' (disabled)' : ''}`)
  }
  const uiStep = async (step: E2EStep): Promise<boolean> => {
    if (step.action === 'menu' && step.path) emit({ type: 'menu', action: step.path as Extract<AppEvent, { type: 'menu' }>['action'] })
    else if (step.action === 'wait') await new Promise((r) => setTimeout(r, Number(step.path ?? 2000)))
    else if (step.action === 'eval' && step.path) log.push(`eval: ${JSON.stringify(await win?.webContents.executeJavaScript(step.path))}`)
    else if (step.action === 'audit') log.push(`audit ${step.path ?? ''}: ${JSON.stringify(await win?.webContents.executeJavaScript(UI_AUDIT_SCRIPT))}`)
    else if (step.action === 'click' && step.path) await clickLabel(step.path)
    else if (step.action === 'type' && step.path !== undefined) {
      // Real key events into whatever has focus (for example the terminal); "\n" presses Enter.
      for (const ch of step.path) {
        if (ch === '\n') {
          win?.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
          win?.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
          win?.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
        } else win?.webContents.sendInputEvent({ type: 'char', keyCode: ch })
      }
      await new Promise((r) => setTimeout(r, 1500))
      log.push(`terminal output so far: ${JSON.stringify(e2eTerminal.join('').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').slice(-300))}`)
    } else if (step.action === 'wheel') {
      // Real mouse-wheel scroll over the chat list. Chromium wheel deltas are positive
      // upwards, so a positive path scrolls up and a negative one down.
      const box = await win?.webContents.executeJavaScript(`(() => { const r = document.querySelector('.messages')?.getBoundingClientRect(); return r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null })()`)
      if (box) win?.webContents.sendInputEvent({ type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: Number(step.path ?? -600), canScroll: true })
      await new Promise((r) => setTimeout(r, 600))
    }
    else if (step.action === 'screenshot' && step.path) {
      await new Promise((r) => setTimeout(r, 1200))
      await capture(step.path)
    } else return false
    return true
  }
  if (cfg.noRoom) {
    for (const step of cfg.steps) {
      try {
        await uiStep(step)
      } catch (err) {
        log.push(`step failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    await capture(cfg.screenshot)
    store.flush()
    writeFileSync(`${cfg.screenshot}.json`, JSON.stringify({ log, rooms: store.list() }, null, 1))
    quitConfirmed = true
    app.quit()
    return
  }
  const ids = cfg.accounts ?? (cfg.kind === 'codex' ? [accounts.firstOf('codex')!.id] : cfg.kind === 'claude' ? [accounts.firstOf('claude')!.id] : [accounts.firstOf('claude')!.id, accounts.firstOf('codex')!.id])
  const room = await rooms.create({ folder: cfg.folder, kind: cfg.kind, accountIds: ids, isolation: !!cfg.isolation })
  if (cfg.memberSettings) for (const m of room.members) rooms.updateMember(room.id, m.id, cfg.memberSettings)
  emit({ type: 'open-room', roomId: room.id })
  await new Promise((r) => setTimeout(r, 1500))
  const waitIdle = async (): Promise<void> => {
    const deadline = Date.now() + (cfg.timeoutMs ?? 300000)
    let idleSince = 0
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000))
      const current = rooms.get(room.id)
      if (cfg.approve && current) {
        for (const m of current.messages)
          for (const b of m.blocks)
            if (b.kind === 'approval' && b.status === 'pending') rooms.answer(room.id, m.id, b.id, b.questions ? { kind: 'answer', answers: Object.fromEntries(b.questions.map((q) => [q.id, q.options[0]?.label ?? 'yes'])) } : { kind: 'allow' })
      }
      if (rooms.busyRooms().includes(room.id)) idleSince = 0
      else if (!idleSince) idleSince = Date.now()
      else if (Date.now() - idleSince > 4000) return
    }
    log.push('timeout')
  }
  const lastAgent = (): string | undefined => [...(rooms.get(room.id)?.messages ?? [])].reverse().find((m) => m.author !== 'user')?.id
  const lastUser = (): string | undefined => [...(rooms.get(room.id)?.messages ?? [])].reverse().find((m) => m.author === 'user')?.id
  for (const step of cfg.steps) {
    try {
      if (step.text) {
        const current = rooms.get(room.id)!
        rooms.send(room.id, { text: step.text, to: parseMentions(step.text, current.members) ?? [], attachments: [] })
        if (!step.noWait) await waitIdle()
      } else if (await uiStep(step)) {
        // handled above
      } else if (step.action === 'member-settings' && step.path) {
        // Change every agent's settings mid-session, as the model/mode menus do.
        for (const m of rooms.get(room.id)?.members ?? []) rooms.updateMember(room.id, m.id, JSON.parse(step.path))
      } else if (step.action === 'idle') {
        await waitIdle()
      } else if (step.action === 'tick' && step.path) {
        const members = rooms.get(room.id)?.members ?? []
        rooms.updateRoom(room.id, { active: members.filter((m) => step.path!.split(',').includes(m.provider)).map((m) => m.id) })
      } else if (step.action === 'export-copy') {
        const r = await api.exportChat(room.id, 'copy')
        const text = await clipboard.readText()
        log.push(`export: ${r.action}, ${text.length} chars, header=${text.startsWith('# ')}, messages=${(text.match(/^## \d+\. /gm) ?? []).length}`)
      } else if (step.action === 'retry') {
        await rooms.retry(room.id, lastAgent()!)
        await waitIdle()
      } else if (step.action === 'edit') {
        log.push(`edit: ${await rooms.editMessage(room.id, lastUser()!, step.path ?? 'edited', true)}`)
        await waitIdle()
      } else if (step.action === 'undo') {
        log.push(`undo: ${await rooms.undoTurn(room.id, lastAgent()!)}`)
      } else if (step.action === 'add-account' && step.path) {
        const [provider, name] = step.path.split(':')
        log.push(`added ${JSON.stringify(accounts.add(provider as 'claude' | 'codex', name))}`)
      } else if (step.action === 'terminal') {
        const t = await terminals.create(cfg.folder, accounts.get(step.path ?? '') ?? undefined, 80, 24)
        terminals.write(t.id, 'echo "IFACE_$((40+2))"; echo "home=${CLAUDE_CONFIG_DIR:-default}"\r')
        await new Promise((r) => setTimeout(r, 2500))
        const out = e2eTerminal.join('')
        log.push(`terminal ${t.title}: ${/IFACE_42/.test(out) ? 'ok' : 'no output'} ${/home=[^\r\n]*/.exec(out)?.[0] ?? ''}`)
      } else if (step.action === 'merge') {
        for (const m of rooms.get(room.id)?.members ?? []) {
          if (m.worktree) log.push(`merge ${m.name}: ${await rooms.mergeWorktree(room.id, m.id)}`)
        }
      } else if (step.action === 'usage') {
        for (const a of accounts.list()) await accounts.refresh(a.id)
      }
    } catch (err) {
      log.push(`step failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  await new Promise((r) => setTimeout(r, 1500))
  const image = await win?.webContents.capturePage()
  if (image) writeFileSync(cfg.screenshot, image.toPNG())
  store.flush()
  writeFileSync(
    `${cfg.screenshot}.json`,
    JSON.stringify({ log, agents, accountInfo: Object.fromEntries(accounts.info), meta: Object.fromEntries(accounts.meta), room: rooms.get(room.id) }, null, 1)
  )
  quitConfirmed = true
  app.quit()
}

// ---------- lifecycle ----------

void app.whenReady().then(async () => {
  const dataDir = app.getPath('userData')
  store = new Store(dataDir)
  nativeTheme.themeSource = store.settings.theme
  await initShellPath()
  accounts = new AccountManager(store, {
    emit,
    binaries,
    openUrl: (url) => void shell.openExternal(url),
    version: app.getVersion(),
    dataDir
  })
  rooms = new RoomManager(store, accounts, {
    emit,
    notify,
    binaries,
    codexAppServer: () => codexAppServer,
    dataDir
  })
  files = new Files(
    () => rooms.roots(),
    (dir) => emit({ type: 'dir-changed', path: dir })
  )
  terminals = new Terminals(emit)
  registerIpc()
  registerProtocol()
  buildMenu()
  await detectAgents()
  win = createWindow()
  win.webContents.once('did-finish-load', () => {
    accounts.refreshAll()
    if (process.env.INTERFACE_E2E) void runE2E(process.env.INTERFACE_E2E)
  })

  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) win = createWindow()
  })
})

app.on('before-quit', (e) => {
  if (!quitConfirmed && rooms?.busyRooms().length) {
    const choice = dialog.showMessageBoxSync({
      type: 'question',
      buttons: ['Quit', 'Cancel'],
      defaultId: 1,
      message: 'An agent is still working',
      detail: 'Quitting stops it. Its reply so far is kept.'
    })
    if (choice === 1) {
      e.preventDefault()
      return
    }
  }
  quitConfirmed = true
  rooms?.disposeAll()
  accounts?.dispose()
  terminals?.killAll()
  files?.closeAll()
  store?.flush()
})

app.on('window-all-closed', () => {
  if (!isMac) app.quit()
})

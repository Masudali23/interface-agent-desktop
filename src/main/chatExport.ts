import { copyFile, mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, writeFile, type FileHandle } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { deflateRaw } from 'node:zlib'
import type { Attachment, Room } from '@shared/types'
import { collabDir } from './protocol'
import { chatExportFilename, formatChatMarkdown } from './exportMarkdown'

const compress = promisify(deflateRaw)

export interface ExportAsset {
  originalPath: string
  name: string
  sourcePath: string
}

export interface PreparedChatExport {
  room: Room
  exportedAt: number
  taskBoard?: string
  assets: ExportAsset[]
  missing: Set<string>
}

function safeAssetName(name: string): string {
  const cleaned = basename(name.replace(/\\/g, '/')).replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
  const extension = extname(cleaned).slice(0, 20)
  let stem = ''
  for (const character of cleaned.slice(0, cleaned.length - extension.length)) {
    if (Buffer.byteLength(stem + character + extension, 'utf8') > 180) break
    stem += character
  }
  return `${stem}${extension}` || 'attachment'
}

/** Capture only data and attachment files recorded in this room. */
export async function prepareChatExport(room: Room): Promise<PreparedChatExport> {
  // Streaming continues while dialogs and filesystem reads are in progress.
  const snapshot = structuredClone(room)
  const result: PreparedChatExport = { room: snapshot, exportedAt: Date.now(), assets: [], missing: new Set() }
  const roots = [snapshot.folder, ...snapshot.members.flatMap((m) => m.worktree ? [m.worktree.path] : [])]
  const resolvedRoots = (await Promise.all(roots.map((root) => realpath(root).catch(() => undefined)))).filter((root): root is string => !!root)
  const attachments = new Map<string, Attachment>()
  for (const message of snapshot.messages) {
    for (const attachment of message.attachments ?? []) attachments.set(attachment.path, attachment)
  }
  for (const attachment of attachments.values()) {
    try {
      const full = await realpath(attachment.path)
      if (!resolvedRoots.some((root) => full === root || full.startsWith(root === sep ? root : root + sep))) {
        throw new Error('Attachment outside this session')
      }
      if (!(await stat(full)).isFile()) throw new Error('Attachment is not a file')
      result.assets.push({ originalPath: attachment.path, name: `${String(result.assets.length + 1).padStart(4, '0')}-${safeAssetName(attachment.name)}`, sourcePath: full })
    } catch {
      result.missing.add(attachment.path)
    }
  }
  try {
    result.taskBoard = await readFile(join(snapshot.folder, collabDir(snapshot.id), 'tasks.md'), 'utf8')
  } catch {
    // Solo sessions, read-only folders and old rooms may have no task board.
  }
  return result
}

function markdown(data: PreparedChatExport, link: (asset: ExportAsset) => string): string {
  const assets = new Map(data.assets.map((asset) => [asset.originalPath, asset]))
  return formatChatMarkdown(data.room, {
    exportedAt: data.exportedAt,
    taskBoard: data.taskBoard,
    attachmentLink: (attachment) => {
      const asset = assets.get(attachment.path)
      return asset ? link(asset) : undefined
    },
    attachmentNote: (attachment) => data.missing.has(attachment.path) ? 'Attachment unavailable at export time.' : undefined
  })
}

export function chatClipboardMarkdown(data: PreparedChatExport): string {
  return markdown(data, (asset) => pathToFileURL(asset.originalPath).href)
}

/** Each save gets its own assets folder so overwrites cannot damage older exports. */
export async function saveChatMarkdown(data: PreparedChatExport, filePath: string): Promise<void> {
  let assetDir: string | undefined
  const staging = await mkdtemp(join(dirname(filePath), '.interface-export-'))
  let saved = false
  try {
    if (data.assets.length) {
      const stem = safeAssetName(basename(filePath, extname(filePath)))
      assetDir = await mkdtemp(join(dirname(filePath), `${stem}-attachments-`))
      for (const asset of data.assets) await copyFile(asset.sourcePath, join(assetDir, asset.name))
    }
    const content = markdown(data, (asset) => `${encodeURIComponent(basename(assetDir!))}/${encodeURIComponent(asset.name)}`)
    const staged = join(staging, 'chat.md')
    await writeFile(staged, content, { encoding: 'utf8', mode: 0o600 })
    await rename(staged, filePath)
    saved = true
  } finally {
    await rm(staging, { recursive: true, force: true })
    if (!saved && assetDir) await rm(assetDir, { recursive: true, force: true })
  }
}

// Standard ZIP with UTF-8 names, CRC32 and DEFLATE; no system archiver or extra runtime dependency.
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  return crc >>> 0
})

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]
  return (crc ^ 0xffffffff) >>> 0
}

async function writeChatZip(data: PreparedChatExport, output: FileHandle): Promise<void> {
  const content = markdown(data, (asset) => `attachments/${encodeURIComponent(asset.name)}`)
  const entries = [
    { name: chatExportFilename(data.room), source: Buffer.from(content, 'utf8') },
    ...data.assets.map((asset) => ({ name: `attachments/${asset.name}`, source: asset.sourcePath }))
  ]
  if (entries.length > 65535) throw new Error('This chat has too many attachments for one ZIP.')
  const directory: Buffer[] = []
  let offset = 0
  const date = new Date(data.exportedAt)
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const dosDate = ((Math.max(1980, Math.min(2107, date.getFullYear())) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const bytes = typeof entry.source === 'string' ? await readFile(entry.source) : entry.source
    const compressed = await compress(bytes)
    if (bytes.length > 0xffffffff || offset + compressed.length + name.length + 30 > 0xffffffff) {
      throw new Error('This chat is too large for one ZIP.')
    }
    const checksum = crc32(bytes)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt16LE(dosTime, 10)
    local.writeUInt16LE(dosDate, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(bytes.length, 22)
    local.writeUInt16LE(name.length, 26)
    await output.writeFile(local)
    await output.writeFile(name)
    await output.writeFile(compressed)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt16LE(dosTime, 12)
    central.writeUInt16LE(dosDate, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(bytes.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE((0o100600 << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    directory.push(central, name)
    offset += local.length + name.length + compressed.length
  }
  const centralSize = directory.reduce((sum, part) => sum + part.length, 0)
  if (offset + centralSize > 0xffffffff) throw new Error('This chat is too large for one ZIP.')
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  for (const part of directory) await output.writeFile(part)
  await output.writeFile(end)
}

export async function saveChatZip(data: PreparedChatExport, filePath: string): Promise<void> {
  const staging = await mkdtemp(join(dirname(filePath), '.interface-export-'))
  const staged = join(staging, 'chat.zip')
  try {
    const output = await open(staged, 'w', 0o600)
    try {
      await writeChatZip(data, output)
    } finally {
      await output.close()
    }
    await rename(staged, filePath)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

export async function chatShareFile(data: PreparedChatExport, tempRoot: string): Promise<string> {
  await mkdir(tempRoot, { recursive: true })
  const dir = await mkdtemp(join(resolve(tempRoot), 'interface-chat-'))
  const filePath = join(dir, chatExportFilename(data.room).replace(/\.md$/, '.zip'))
  await saveChatZip(data, filePath)
  return filePath
}

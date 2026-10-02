import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { chatClipboardMarkdown, chatShareFile, prepareChatExport, saveChatMarkdown, saveChatZip } from '../src/main/chatExport'
import { chatExportFilename } from '../src/main/exportMarkdown'
import type { Attachment, Room } from '../src/shared/types'

const directories: string[] = []
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'interface-export-test-'))
  directories.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function room(folder: string, attachments: Attachment[] = []): Room {
  return {
    id: 'r-export', title: 'Complete chat', folder, kind: 'team', createdAt: 0, updatedAt: 0,
    members: [], autoRelay: false, maxHops: 0, isolation: false, sessions: {},
    messages: [{ id: 'm1', author: 'user', createdAt: 0, text: 'Please implement this.', blocks: [], status: 'done', attachments }]
  }
}

describe('portable chat exports', () => {
  it('captures a stable snapshot, task board and duplicate attachments once', async () => {
    const dir = await temp()
    const file = join(dir, 'image.png')
    await writeFile(file, Buffer.from([0, 1, 2, 255]))
    const attachment: Attachment = { name: 'image.png', path: file, mime: 'image/png', size: 4 }
    const chat = room(dir, [attachment, attachment])
    await mkdir(join(dir, '.collab', chat.id), { recursive: true })
    await writeFile(join(dir, '.collab', chat.id, 'tasks.md'), '# Tasks\n- [x] Implementation complete\n')
    const promise = prepareChatExport(chat)
    chat.messages[0].text = 'Later streaming mutation'
    const data = await promise
    expect(data.room.messages[0].text).toBe('Please implement this.')
    expect(data.assets).toHaveLength(1)
    expect(await readFile(data.assets[0].sourcePath)).toEqual(Buffer.from([0, 1, 2, 255]))
    expect(data.taskBoard).toContain('Implementation complete')
    const text = chatClipboardMarkdown(data)
    expect(text).toContain('file://')
    expect(text).toContain('Implementation complete')
  })

  it('reports missing files and rejects symlinks outside the chat roots', async () => {
    const dir = await temp()
    const outside = await temp()
    await writeFile(join(outside, 'private.txt'), 'Do not include unrelated files')
    await symlink(join(outside, 'private.txt'), join(dir, 'alias.txt'))
    const attachment = (path: string): Attachment => ({ name: 'file.txt', path, mime: 'text/plain', size: 0 })
    const data = await prepareChatExport(room(dir, [attachment(join(dir, 'gone.txt')), attachment(join(dir, 'alias.txt'))]))
    expect(data.assets).toHaveLength(0)
    expect(data.missing.size).toBe(2)
    expect(chatClipboardMarkdown(data)).toContain('Attachment unavailable at export time.')
    expect(chatClipboardMarkdown(data)).not.toContain('Do not include unrelated files')
  })

  it('saves Markdown with relative attachments and keeps earlier exports intact', async () => {
    const dir = await temp()
    const image = join(dir, 'image (1).png')
    const bytes = Buffer.from([137, 80, 78, 71])
    await writeFile(image, bytes)
    const data = await prepareChatExport(room(dir, [{ name: '../../image (1).png', path: image, mime: 'image/png', size: 4 }]))
    const out = join(dir, 'chat.md')
    await saveChatMarkdown(data, out)
    const first = await readFile(out, 'utf8')
    expect(first).toContain('chat-attachments-')
    expect(first).not.toContain('file://')
    expect(first).not.toContain('(<../../')
    expect(data.assets[0].name).not.toContain('../')
    const dirs = (await readdir(dir)).filter((name) => name.startsWith('chat-attachments-'))
    expect(dirs).toHaveLength(1)
    expect(await readFile(join(dir, dirs[0], data.assets[0].name))).toEqual(bytes)
    await saveChatMarkdown(data, out)
    expect((await readdir(dir)).filter((name) => name.startsWith('chat-attachments-'))).toHaveLength(2)
    expect(await readFile(join(dir, dirs[0], data.assets[0].name))).toEqual(bytes)
  })

  it.skipIf(spawnSync('unzip', ['-v']).status !== 0)('creates a standard ZIP verified and extracted by the system unzip', async () => {
    const dir = await temp()
    const bytes = Buffer.from('123456789')
    const file = join(dir, 'payload.txt')
    await writeFile(file, bytes)
    const data = await prepareChatExport(room(dir, [{ name: 'हिन्दी payload.txt', path: file, mime: 'text/plain', size: bytes.length }]))
    const zip = join(dir, 'chat.zip')
    await saveChatZip(data, zip)
    expect(execFileSync('unzip', ['-t', zip], { encoding: 'utf8' })).toContain('No errors detected')
    const extracted = join(dir, 'unpacked')
    await mkdir(extracted)
    execFileSync('unzip', ['-q', zip, '-d', extracted])
    expect(await readFile(join(extracted, 'attachments', data.assets[0].name))).toEqual(bytes)
    const md = await readFile(join(extracted, chatExportFilename(data.room)), 'utf8')
    expect(md).toContain(`attachments/${encodeURIComponent(data.assets[0].name)}`)
    expect(md).toContain('Please implement this.')
  })

  it('creates a unique share package that remains available after preparation', async () => {
    const dir = await temp()
    const data = await prepareChatExport(room(dir))
    const first = await chatShareFile(data, dir)
    const second = await chatShareFile(data, dir)
    expect(first).not.toBe(second)
    expect((await readFile(first)).readUInt32LE(0)).toBe(0x04034b50)
    expect(await readFile(first)).toEqual(await readFile(second))
  })

  it('keeps long Unicode attachment names within filesystem limits', async () => {
    const dir = await temp()
    const path = join(dir, 'payload.txt')
    await writeFile(path, 'content')
    const data = await prepareChatExport(room(dir, [{ name: `${'图'.repeat(200)}.txt`, path, mime: 'text/plain', size: 7 }]))
    expect(Buffer.byteLength(data.assets[0].name)).toBeLessThan(200)
    expect(data.assets[0].name).toMatch(/\.txt$/)
    await saveChatMarkdown(data, join(dir, 'chat.md'))
  })

  it('leaves existing exports untouched if an attachment disappears during save', async () => {
    const dir = await temp()
    const path = join(dir, 'payload.txt')
    await writeFile(path, 'content')
    const data = await prepareChatExport(room(dir, [{ name: 'payload.txt', path, mime: 'text/plain', size: 7 }]))
    await rm(path)
    const markdown = join(dir, 'chat.md')
    const zip = join(dir, 'chat.zip')
    await writeFile(markdown, 'previous Markdown export')
    await writeFile(zip, 'previous ZIP export')
    await expect(saveChatMarkdown(data, markdown)).rejects.toThrow()
    await expect(saveChatZip(data, zip)).rejects.toThrow()
    expect(await readFile(markdown, 'utf8')).toBe('previous Markdown export')
    expect(await readFile(zip, 'utf8')).toBe('previous ZIP export')
    expect((await readdir(dir)).some((name) => name.startsWith('.interface-export-') || name.startsWith('chat-attachments-'))).toBe(false)
  })
})

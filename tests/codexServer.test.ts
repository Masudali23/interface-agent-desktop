import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexServer, type ThreadHandler } from '../src/main/agents/codexServer'

// Stand-ins for two installed versions of `codex app-server`: each answers model/list with its
// own version, and `slow` some time later.
const dir = mkdtempSync(join(tmpdir(), 'iface-codex-server-'))
function fakeCodex(version: string): string {
  const file = join(dir, `codex-${version}`)
  writeFileSync(
    file,
    `#!/usr/bin/env node
require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line)
  if (msg.id === undefined) return
  const reply = (result) => process.stdout.write(JSON.stringify({ id: msg.id, result }) + '\\n')
  if (msg.method === 'slow') return setTimeout(() => reply({}), 300)
  reply(msg.method === 'model/list' ? { data: [{ id: '${version}' }] } : {})
})
`
  )
  chmodSync(file, 0o755)
  return file
}
const v1 = fakeCodex('v1')
const v2 = fakeCodex('v2')

const servers: CodexServer[] = []
afterEach(() => servers.splice(0).forEach((s) => s.dispose()))

function setup() {
  let binary = v1
  const server = new CodexServer(() => binary, () => process.env, 'test')
  servers.push(server)
  const restarted = vi.fn()
  server.on('restarted', restarted)
  const model = async () => (await server.request<{ data: Array<{ id: string }> }>('model/list', {})).data[0].id
  return { server, restarted, model, install: (file: string) => (binary = file) }
}

function thread(busy = false): ThreadHandler & { working: boolean; closed: ReturnType<typeof vi.fn> } {
  const h = { working: busy, notify: vi.fn(), request: vi.fn(), closed: vi.fn(), busy: () => h.working }
  return h
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

describe('CodexServer after Codex is updated', () => {
  it('restarts on the new version once idle, and idle threads resume later', async () => {
    const { server, restarted, model, install } = setup()
    expect(await model()).toBe('v1')
    const t = thread()
    server.subscribe('thread-1', t)
    install(v2)
    server.restartWhenIdle()
    await tick()
    expect(restarted).toHaveBeenCalledTimes(1)
    expect(t.closed).toHaveBeenCalledTimes(1)
    expect(await model()).toBe('v2')
    expect(restarted).toHaveBeenCalledTimes(1)
  })

  it('waits for a running turn to finish', async () => {
    const { server, restarted, model, install } = setup()
    await model()
    const t = thread(true)
    server.subscribe('thread-1', t)
    install(v2)
    server.restartWhenIdle()
    await tick()
    expect(await model()).toBe('v1')
    expect(t.closed).not.toHaveBeenCalled()
    t.working = false
    // The next answer or notification after the turn ends lets it restart.
    expect(await model()).toBe('v1')
    await tick()
    expect(restarted).toHaveBeenCalledTimes(1)
    expect(await model()).toBe('v2')
  })

  it('waits for open requests and a sign-in in progress', async () => {
    const { server, restarted, model, install } = setup()
    await model()
    let signingIn = true
    install(v2)
    const slow = server.request('slow', {})
    server.restartWhenIdle(() => signingIn)
    await tick()
    expect(restarted).not.toHaveBeenCalled()
    await slow
    await tick()
    expect(restarted).not.toHaveBeenCalled()
    signingIn = false
    expect(await model()).toBe('v1')
    await tick()
    expect(restarted).toHaveBeenCalledTimes(1)
    expect(await model()).toBe('v2')
  })

  it('needs no restart when it is not running', async () => {
    const { server, restarted, model, install } = setup()
    install(v2)
    server.restartWhenIdle()
    await tick()
    expect(restarted).not.toHaveBeenCalled()
    expect(await model()).toBe('v2')
  })
})

process.on('exit', () => rmSync(dir, { recursive: true, force: true }))

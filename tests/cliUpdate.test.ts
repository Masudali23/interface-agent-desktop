import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { claudeChannel, isNewer, latestRelease, updateResult, versionNumber } from '../src/main/cliUpdate'

describe('program versions', () => {
  it('reads the version from what each program prints', () => {
    expect(versionNumber('codex-cli 0.154.0')).toBe('0.154.0')
    expect(versionNumber('2.1.309 (Claude Code)')).toBe('2.1.309')
    expect(versionNumber('0.161.0-alpha.13.1')).toBe('0.161.0')
    expect(versionNumber(undefined)).toBeUndefined()
    expect(versionNumber('codex')).toBeUndefined()
  })

  it('compares releases by number, not as text', () => {
    expect(isNewer('0.166.0', '0.154.0')).toBe(true)
    expect(isNewer('0.154.0', '0.166.0')).toBe(false)
    expect(isNewer('2.1.316', '2.1.309')).toBe(true)
    expect(isNewer('2.10.0', '2.9.9')).toBe(true)
    expect(isNewer('1.0.0', '1.0.0')).toBe(false)
  })

  it('follows the update channel chosen in Claude Code settings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iface-channel-'))
    try {
      expect(claudeChannel(dir)).toBe('latest')
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({ autoUpdatesChannel: 'stable' }))
      expect(claudeChannel(dir)).toBe('stable')
      writeFileSync(join(dir, 'settings.json'), '{ not json')
      expect(claudeChannel(dir)).toBe('latest')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('newest release', () => {
  const tags = { latest: '0.166.0', beta: '0.1.2505172116', 'release-0.161.0-alpha': '0.161.0-alpha.13.1' }

  it('asks npm for the release each updater installs', async () => {
    const fetchJson = vi.fn(async () => tags)
    expect(await latestRelease('codex', fetchJson)).toBe('0.166.0')
    expect(fetchJson).toHaveBeenCalledWith('https://registry.npmjs.org/-/package/@openai%2fcodex/dist-tags')
    const claude = vi.fn(async () => ({ stable: '2.1.309', latest: '2.1.316' }))
    expect(await latestRelease('claude', claude, 'stable')).toBe('2.1.309')
    expect(await latestRelease('claude', claude, 'latest')).toBe('2.1.316')
    expect(claude).toHaveBeenCalledWith('https://registry.npmjs.org/-/package/@anthropic-ai%2fclaude-code/dist-tags')
  })

  it('has no answer for an unexpected reply', async () => {
    expect(await latestRelease('codex', async () => ({}))).toBeUndefined()
    expect(await latestRelease('codex', async () => null)).toBeUndefined()
    expect(await latestRelease('codex', async () => ({ latest: 7 }))).toBeUndefined()
    await expect(latestRelease('codex', async () => Promise.reject(new Error('offline')))).rejects.toThrow('offline')
  })
})

describe('update result', () => {
  it('reports a new version', () => {
    expect(updateResult('codex', { code: 0, out: 'changed 2 packages' }, '0.154.0', '0.166.0', '0.166.0')).toEqual({
      ok: true,
      message: 'Codex updated from 0.154.0 to 0.166.0.'
    })
  })

  it('explains a failed update with its last line of output', () => {
    const out = 'Updating Codex via `npm install -g @openai/codex`...\n\x1b[31mnpm error code EACCES\x1b[0m\n\n'
    expect(updateResult('codex', { code: 1, out }, '0.154.0', '0.154.0', '0.166.0')).toEqual({
      ok: false,
      message: 'Codex could not update itself: npm error code EACCES. Run `codex update` in a terminal to see why.'
    })
    expect(updateResult('claude', { code: 1, out: '' }, '2.1.287', '2.1.287', '2.1.316').message).toBe(
      'Claude Code could not update itself. Run `claude update` in a terminal to see why.'
    )
  })

  it('says when the installer has nothing newer yet', () => {
    expect(updateResult('codex', { code: 0, out: '' }, '0.160.0', '0.160.0', '0.166.0')).toEqual({
      ok: false,
      notOffered: true,
      message: 'Codex is still 0.160.0: its installer does not offer 0.166.0 yet. Try again later.'
    })
    expect(updateResult('claude', { code: 0, out: 'Claude Code is up to date' }, '2.1.316', '2.1.316', '2.1.316')).toEqual({
      ok: true,
      message: 'Claude Code is up to date (2.1.316).'
    })
  })
})

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { claudeChannel, isNewer, latestRelease, updateResult, versionNumber } from '../src/main/cliUpdate'

describe('program versions', () => {
  it('reads the version from what each program prints', () => {
    expect(versionNumber('codex-cli 0.154.0')).toBe('0.154.0')
    expect(versionNumber('2.1.309 (Claude Code)')).toBe('2.1.309')
    expect(versionNumber('codex-cli 0.161.0-alpha.13.1')).toBe('0.161.0-alpha.13.1')
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

  it('puts a release after its own pre-releases', () => {
    expect(isNewer('0.167.0', '0.167.0-alpha.3')).toBe(true)
    expect(isNewer('0.167.0-alpha.3', '0.167.0')).toBe(false)
    expect(isNewer('0.167.0-alpha.10', '0.167.0-alpha.9')).toBe(true)
    expect(isNewer('0.167.0-beta', '0.167.0-alpha.9')).toBe(true)
    expect(isNewer('0.167.0-alpha.beta', '0.167.0-alpha.9')).toBe(true)
    expect(isNewer('1.0.0-alpha', '1.0.0-alpha.1')).toBe(false)
    expect(isNewer('0.166.0', '0.167.0-alpha.3')).toBe(false)
  })
})

describe('Claude Code update channel', () => {
  it('follows autoUpdatesChannel in Claude Code settings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iface-channel-'))
    try {
      expect(claudeChannel(undefined, dir)).toBe('latest')
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({ autoUpdatesChannel: 'stable' }))
      expect(claudeChannel(undefined, dir)).toBe('stable')
      writeFileSync(join(dir, 'settings.json'), '{ not json')
      expect(claudeChannel(undefined, dir)).toBe('latest')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("follows a Homebrew cask's own channel, whatever the settings say", () => {
    const dir = mkdtempSync(join(tmpdir(), 'iface-cask-'))
    try {
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({ autoUpdatesChannel: 'latest' }))
      mkdirSync(join(dir, 'bin'))
      for (const cask of ['claude-code', 'claude-code@latest']) {
        mkdirSync(join(dir, 'Caskroom', cask, '2.1.300'), { recursive: true })
        writeFileSync(join(dir, 'Caskroom', cask, '2.1.300', 'claude'), '')
        symlinkSync(join(dir, 'Caskroom', cask, '2.1.300', 'claude'), join(dir, 'bin', cask))
      }
      expect(claudeChannel(join(dir, 'bin', 'claude-code'), dir)).toBe('stable')
      expect(claudeChannel(join(dir, 'bin', 'claude-code@latest'), dir)).toBe('latest')
      expect(claudeChannel(join(dir, 'bin', 'missing'), dir)).toBe('latest')
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

  it('explains a failed update with the error, not the advice after it', () => {
    const npm = 'Updating Codex via `npm install -g @openai/codex`...\n\x1b[31mnpm error code EACCES\x1b[0m\nnpm error syscall rename\n\n'
    expect(updateResult('codex', { code: 1, out: npm }, '0.154.0', '0.154.0', '0.166.0')).toEqual({
      ok: false,
      message: 'Codex could not update itself: npm error code EACCES. Run `codex update` in a terminal to see why.'
    })
    const claude =
      'Error: Insufficient permissions to install update\nTry running with sudo or fix npm permissions\nOr consider using native installation with: claude install\n'
    expect(updateResult('claude', { code: 1, out: claude }, '2.1.287', '2.1.287', '2.1.316').message).toBe(
      'Claude Code could not update itself: Error: Insufficient permissions to install update. Run `claude update` in a terminal to see why.'
    )
    expect(updateResult('claude', { code: 1, out: '' }, '2.1.287', '2.1.287', '2.1.316').message).toBe(
      'Claude Code could not update itself. Run `claude update` in a terminal to see why.'
    )
  })

  it("passes on the updater's own words when it leaves the version unchanged", () => {
    const brew = 'Claude is managed by Homebrew.\nUpdate available: 2.1.300 → 2.1.309\n\nTo update, run:\n  brew upgrade claude-code\n'
    expect(updateResult('claude', { code: 0, out: brew }, '2.1.300', '2.1.300', '2.1.309')).toEqual({
      ok: false,
      notOffered: true,
      message:
        'Claude Code is still 2.1.300. Its updater says: Claude is managed by Homebrew. Update available: 2.1.300 → 2.1.309 To update, run: brew upgrade claude-code'
    })
    expect(updateResult('codex', { code: 0, out: '' }, '0.160.0', '0.160.0', '0.166.0')).toEqual({
      ok: false,
      notOffered: true,
      message: 'Codex is still 0.160.0: its installer does not offer 0.166.0 yet.'
    })
    expect(updateResult('claude', { code: 0, out: 'Claude Code is up to date' }, '2.1.316', '2.1.316', '2.1.316')).toEqual({
      ok: true,
      message: 'Claude Code is up to date (2.1.316).'
    })
  })
})

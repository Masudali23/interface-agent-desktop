// New Claude Code and Codex releases bring new models: the model menus list what the
// installed program offers. Interface runs the programs you installed, so it looks up their
// newest release and runs each program's own updater, keeping them current the way the
// Claude and Codex desktop apps keep their built-in copies current.

import { readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PROVIDER_LABEL, type Provider } from '@shared/types'

const PACKAGES: Record<Provider, string> = { claude: '@anthropic-ai/claude-code', codex: '@openai/codex' }

/** "codex-cli 0.166.0" or "2.1.309 (Claude Code)" → "0.166.0" or "2.1.309"; pre-releases keep their tag. */
export function versionNumber(text: string | undefined): string | undefined {
  return /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(text ?? '')?.[0]
}

function parts(version: string): { nums: number[]; pre: string[] } {
  const dash = version.indexOf('-')
  const main = dash < 0 ? version : version.slice(0, dash)
  return { nums: main.split('.').map(Number), pre: dash < 0 ? [] : version.slice(dash + 1).split('.') }
}

/** True when release `a` is later than release `b`, in semver order (0.167.0 is later than 0.167.0-alpha.3). */
export function isNewer(a: string, b: string): boolean {
  const x = parts(a)
  const y = parts(b)
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] || 0) - (y.nums[i] || 0)
    if (d) return d > 0
  }
  if (!x.pre.length || !y.pre.length) return !x.pre.length && y.pre.length > 0
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined) return false
    if (q === undefined) return true
    if (p === q) continue
    const pn = /^\d+$/.test(p)
    const qn = /^\d+$/.test(q)
    if (pn && qn) return Number(p) > Number(q)
    // Numeric tags come before named ones (alpha.9 < alpha.beta).
    if (pn !== qn) return qn
    return p > q
  }
  return false
}

/**
 * The channel `claude update` installs from. A Homebrew cask follows its own channel
 * (`claude-code@latest`, otherwise stable); other installs follow `autoUpdatesChannel`
 * in Claude Code's settings.
 */
export function claudeChannel(binary?: string, configDir = join(homedir(), '.claude')): 'stable' | 'latest' {
  let real = binary
  try {
    if (binary) real = realpathSync(binary)
  } catch {
    // Keep the path as given.
  }
  const cask = real ? /\/Caskroom\/([^/]+)\//.exec(real)?.[1] : undefined
  if (cask) return cask === 'claude-code@latest' ? 'latest' : 'stable'
  try {
    return JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8')).autoUpdatesChannel === 'stable' ? 'stable' : 'latest'
  } catch {
    return 'latest'
  }
}

/** The newest release the program's updater would install. */
export async function latestRelease(
  provider: Provider,
  fetchJson: (url: string) => Promise<unknown>,
  channel: string = provider === 'claude' ? claudeChannel() : 'latest'
): Promise<string | undefined> {
  const tags = await fetchJson(`https://registry.npmjs.org/-/package/${PACKAGES[provider].replace('/', '%2f')}/dist-tags`)
  const version = tags && typeof tags === 'object' ? (tags as Record<string, unknown>)[channel] : undefined
  return typeof version === 'string' ? versionNumber(version) : undefined
}

/** The updater's output as lines, without terminal colours or blank lines. */
function outputLines(output: string): string[] {
  return output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split(/\r?\n|\r/).map((l) => l.trim()).filter(Boolean)
}

const shorten = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** What to tell the user after `claude update` or `codex update` finished. */
export function updateResult(
  provider: Provider,
  run: { code: number; out: string },
  before: string | undefined,
  after: string | undefined,
  latest: string | undefined
): { ok: boolean; message: string; notOffered?: boolean } {
  const name = PROVIDER_LABEL[provider]
  if (after && before && after !== before) return { ok: true, message: `${name} updated from ${before} to ${after}.` }
  const lines = outputLines(run.out)
  if (run.code !== 0) {
    // The error itself, not the advice printed after it.
    const why = (lines.find((l) => /\berror\b/i.test(l)) ?? lines[lines.length - 1] ?? '').replace(/[.:]+$/, '')
    return {
      ok: false,
      message: `${name} could not update itself${why ? `: ${shorten(why, 200)}` : ''}. Run \`${provider} update\` in a terminal to see why.`
    }
  }
  if (after && latest && isNewer(latest, after)) {
    // For example Homebrew or a Linux package manager, whose updater says what to run instead.
    const said = lines.join(' ')
    return {
      ok: false,
      notOffered: true,
      message: said ? `${name} is still ${after}. Its updater says: ${shorten(said, 280)}` : `${name} is still ${after}: its installer does not offer ${latest} yet.`
    }
  }
  return { ok: true, message: after ? `${name} is up to date (${after}).` : `${name} is up to date.` }
}

// New Claude Code and Codex releases bring new models: the model menus list what the
// installed program offers. Interface runs the programs you installed, so it looks up their
// newest release and runs each program's own updater, keeping them current the way the
// Claude and Codex desktop apps keep their built-in copies current.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PROVIDER_LABEL, type Provider } from '@shared/types'

const PACKAGES: Record<Provider, string> = { claude: '@anthropic-ai/claude-code', codex: '@openai/codex' }

/** "codex-cli 0.166.0" or "2.1.309 (Claude Code)" → "0.166.0" or "2.1.309". */
export function versionNumber(text: string | undefined): string | undefined {
  return /\d+\.\d+\.\d+/.exec(text ?? '')?.[0]
}

/** True when release `a` is later than release `b`. */
export function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d > 0
  }
  return false
}

/** `claude update` installs from the channel set as `autoUpdatesChannel` in Claude Code's settings. */
export function claudeChannel(configDir = join(homedir(), '.claude')): 'stable' | 'latest' {
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

/** The last line of the updater's output that says something, without terminal colours. */
function lastLine(output: string): string {
  // eslint-disable-next-line no-control-regex
  const lines = output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split(/\r?\n|\r/).map((l) => l.trim()).filter(Boolean)
  const line = lines.pop() ?? ''
  return line.length > 200 ? `${line.slice(0, 199)}…` : line
}

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
  if (run.code !== 0) {
    const why = lastLine(run.out).replace(/[.:]+$/, '')
    return {
      ok: false,
      message: `${name} could not update itself${why ? `: ${why}` : ''}. Run \`${provider} update\` in a terminal to see why.`
    }
  }
  if (after && latest && isNewer(latest, after)) {
    return { ok: false, notOffered: true, message: `${name} is still ${after}: its installer does not offer ${latest} yet. Try again later.` }
  }
  return { ok: true, message: after ? `${name} is up to date (${after}).` : `${name} is up to date.` }
}

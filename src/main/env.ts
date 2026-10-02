// Finding the `claude` and `codex` programs and building a clean environment for them.
//
// Apps started from the macOS Dock or the Ubuntu app menu do not get the PATH from
// your shell profile (nvm, Homebrew, ~/.local/bin…), so the login shell is asked for it.

import { execFile } from 'node:child_process'
import { accessSync, constants, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

let resolvedPath: string | undefined

function readLoginShellPath(): Promise<string | undefined> {
  if (process.platform === 'win32') return Promise.resolve(undefined)
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-ilc', 'printf "__IFACE_PATH__%s__IFACE_PATH__" "$PATH"'],
      { timeout: 6000, env: { ...process.env, TERM: 'dumb' } },
      (_err, stdout) => {
        const m = /__IFACE_PATH__(.*)__IFACE_PATH__/s.exec(String(stdout ?? ''))
        resolve(m?.[1])
      }
    )
  })
}

function extraDirs(): string[] {
  const home = homedir()
  const dirs = [
    join(home, '.local/bin'),
    join(home, '.claude/local'),
    join(home, '.npm-global/bin'),
    join(home, '.bun/bin'),
    join(home, '.volta/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin'
  ]
  try {
    const nvm = join(home, '.nvm/versions/node')
    for (const v of readdirSync(nvm).sort().reverse()) dirs.push(join(nvm, v, 'bin'))
  } catch {
    // no nvm
  }
  return dirs
}

export async function initShellPath(): Promise<void> {
  const fromShell = await readLoginShellPath()
  const parts = [...(fromShell ?? '').split(delimiter), ...(process.env.PATH ?? '').split(delimiter), ...extraDirs()]
  resolvedPath = [...new Set(parts.filter(Boolean))].join(delimiter)
}

/**
 * Environment for the agent processes.
 * Drops variables that would change how the CLIs behave or bill:
 * - CLAUDE_* / CLAUDECODE are set when this app itself is started from inside Claude Code.
 * - API keys would switch the CLIs from your subscription to pay-per-use API billing.
 */
export function agentEnv(account?: { provider: 'claude' | 'codex'; home?: string }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/^CLAUDE/.test(key)) delete env[key]
  }
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY', 'CODEX_API_KEY']) {
    delete env[key]
  }
  delete env.CODEX_HOME
  env.PATH = resolvedPath ?? env.PATH
  // Each extra account keeps its own sign-in, settings and history in its own folder.
  if (account?.home && account.provider === 'claude') env.CLAUDE_CONFIG_DIR = account.home
  if (account?.home && account.provider === 'codex') env.CODEX_HOME = account.home
  return env
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Absolute path of a program: the override if given, otherwise the first match on PATH. */
export function findBinary(name: string, override?: string): string | undefined {
  if (override?.trim()) return isExecutable(override.trim()) ? override.trim() : undefined
  const path = resolvedPath ?? process.env.PATH ?? ''
  for (const dir of path.split(delimiter)) {
    if (!dir) continue
    const file = join(dir, name)
    if (isExecutable(file)) return file
  }
  return undefined
}

export function run(
  file: string,
  args: string[],
  opts: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<{ code: number; out: string; stdout: string }> {
  return new Promise((resolve) => {
    const env = opts.env ?? agentEnv()
    execFile(file, args, { env, cwd: opts.cwd, timeout: opts.timeout ?? 15000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0
      resolve({ code, out: `${stdout ?? ''}${stderr ?? ''}`, stdout: String(stdout ?? '') })
    })
  })
}

// Built-in terminals. Opened "as" an account, the shell gets that account's
// CLAUDE_CONFIG_DIR or CODEX_HOME, so typing `claude` or `codex` runs the full
// interactive tool signed in as that account (for /config, /mcp, /login and anything
// else the app doesn't show itself).

import { homedir } from 'node:os'
import { basename } from 'node:path'
import type { IPty } from 'node-pty'
import type { Account, AppEvent } from '@shared/types'
import { agentEnv } from './env'

export class Terminals {
  private terms = new Map<string, IPty>()
  private next = 1

  constructor(private emit: (e: AppEvent) => void) {}

  async create(cwd: string | undefined, account: Account | undefined, cols: number, rows: number): Promise<{ id: string; title: string }> {
    const pty = await import('node-pty')
    const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
    const env = { ...agentEnv(account), TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>
    const term = pty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: Math.max(20, cols),
      rows: Math.max(5, rows),
      cwd: cwd || homedir(),
      env
    })
    const id = `t${this.next++}`
    this.terms.set(id, term)
    term.onData((data) => this.emit({ type: 'terminal-data', id, data }))
    term.onExit(({ exitCode }) => {
      this.terms.delete(id)
      this.emit({ type: 'terminal-exit', id, code: exitCode })
    })
    const title = `${account ? `${account.name} · ` : ''}${basename(cwd || homedir())}`
    return { id, title }
  }

  write(id: string, data: string): void {
    this.terms.get(id)?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    try {
      this.terms.get(id)?.resize(Math.max(20, cols), Math.max(5, rows))
    } catch {
      // Already exited.
    }
  }

  kill(id: string): void {
    this.terms.get(id)?.kill()
    this.terms.delete(id)
  }

  killAll(): void {
    for (const t of this.terms.values()) t.kill()
    this.terms.clear()
  }
}

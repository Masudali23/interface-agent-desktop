import type {
  AccountInfo,
  ApprovalDecision,
  Attachment,
  ContextUsage,
  McpServer,
  MemberSettings,
  MessageUsage,
  Question,
  RuntimeMeta,
  TurnOverrides
} from '@shared/types'

/** What every agent connector reports, in one common shape. */
export type AgentEvent =
  | { t: 'session'; id: string }
  | { t: 'session-invalid' }
  | { t: 'meta'; meta: Partial<RuntimeMeta>; account?: Partial<AccountInfo> }
  | { t: 'status'; status: 'thinking' | 'working' | 'waiting'; detail?: string }
  | { t: 'block-start'; key: string; kind: 'text' | 'thinking' }
  | { t: 'delta'; key: string; text: string }
  | { t: 'block-set'; key: string; kind: 'text' | 'thinking'; text: string }
  | { t: 'tool-start'; id: string; name: string; input: unknown }
  | { t: 'tool-input'; id: string; name: string; input: unknown }
  | { t: 'tool-output'; id: string; text: string }
  | { t: 'tool-end'; id: string; output?: string; isError?: boolean }
  | {
      t: 'approval'
      requestId: string
      toolName: string
      toolUseId?: string
      input: unknown
      description?: string
      canAlways: boolean
      questions?: Question[]
    }
  | { t: 'approvals-expired' }
  | { t: 'turn-ref'; start?: string; end?: string }
  | { t: 'diff'; diff: string }
  | { t: 'context'; context: ContextUsage }
  | { t: 'account'; info: Partial<AccountInfo> }
  | {
      t: 'turn-end'
      ok: boolean
      stopped?: boolean
      error?: string
      usage?: MessageUsage
    }

export interface TurnInput {
  text: string
  images: Attachment[]
  /** Model and effort for this turn only; saved member settings stay unchanged. */
  overrides?: TurnOverrides
}

export interface AgentConnector {
  readonly busy: boolean
  send(input: TurnInput): void
  interrupt(): void
  answer(requestId: string, decision: ApprovalDecision): void
  /** Applies new settings; live where the harness allows it, otherwise on the next turn. */
  update(settings: MemberSettings, systemPrompt?: string): void
  /**
   * Makes the next turn continue from an earlier point of the agent's own session.
   * `ref` is the turn to keep as the last one; undefined starts a fresh session.
   */
  forkAt(ref: { start?: string; end?: string } | undefined): Promise<void>
  /** Puts back files changed since the turn that started with `ref`. Returns a summary. */
  undoFiles?(ref: { start?: string }, diff?: string): Promise<string>
  /**
   * Hands a new message to the turn that is running, the way typing into Claude Code or
   * the Codex app while it works does. Resolves false when there is no turn to join.
   */
  steer?(input: TurnInput): Promise<boolean>
  /** Handles a harness command that is not a plain message (Codex /review, /compact). */
  command?(name: string, args: string): boolean
  refreshContext(): Promise<void>
  mcpList(): Promise<McpServer[]>
  mcpToggle?(name: string, enabled: boolean): Promise<void>
  mcpReconnect?(name: string): Promise<void>
  dispose(): void
  on(event: 'event', listener: (e: AgentEvent) => void): this
}

export const MAX_TOOL_OUTPUT = 20000

export function clip(text: string, max = MAX_TOOL_OUTPUT): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text
}

/** Reads newline-delimited JSON from a stream. */
export function lineReader(onLine: (line: string) => void): (chunk: Buffer | string) => void {
  let buf = ''
  return (chunk) => {
    buf += chunk.toString()
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (line) onLine(line)
    }
  }
}

export const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

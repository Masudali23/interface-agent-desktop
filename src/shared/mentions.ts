import type { Provider } from './types'

export interface Mentionable {
  id: string
  handle: string
  provider: Provider
}

const GENERIC: Record<string, Provider> = {
  claude: 'claude',
  gpt: 'codex',
  codex: 'codex',
  chatgpt: 'codex',
  openai: 'codex'
}

/**
 * Finds who a message is addressed to: "@work", "@gpt", "@both"/"@all".
 * A member's own handle wins; otherwise "@claude" means every Claude member and
 * "@gpt"/"@codex" every Codex member.
 *
 * Only addressing mentions count: at the start of the message or a line, or after
 * punctuation, "and" or a greeting ("@claude backend, @gpt frontend", "hey @gpt"). A mention inside a
 * sentence ("then hand off to @gpt") is just a reference, not a recipient.
 */
export function parseMentions(text: string, members: Mentionable[]): string[] | undefined {
  const found = new Set<string>()
  const re = /(^|\n|[,;:.!?(&/]|\b(?:and|or|hey|hi|hello|ok|okay|so|now|please|also|thanks))\s*@([\w.-]+)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const handle = m[2].replace(/[.,;:!?-]+$/, '').toLowerCase()
    if (handle === 'both' || handle === 'all' || handle === 'everyone' || handle === 'team') {
      for (const x of members) found.add(x.id)
      continue
    }
    const exact = members.find((x) => x.handle.toLowerCase() === handle)
    if (exact) {
      found.add(exact.id)
      continue
    }
    const provider = GENERIC[handle]
    if (provider) for (const x of members) if (x.provider === provider) found.add(x.id)
  }
  return found.size ? [...found] : undefined
}

export function handleFrom(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'agent'
  )
}

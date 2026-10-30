import type { Attachment } from '@shared/types'

interface Draft {
  text: string
  attachments: Attachment[]
  saving: number
}

const EMPTY_DRAFT: Draft = { text: '', attachments: [], saving: 0 }

/** Drafts outlive mounted composers so asynchronous file saves survive view changes. */
export class ComposerDrafts {
  private drafts = new Map<string, Draft>()
  private listeners = new Map<string, Set<() => void>>()

  get(key: string): Draft { return this.drafts.get(key) ?? EMPTY_DRAFT }

  subscribe(key: string, listener: () => void): () => void {
    const listeners = this.listeners.get(key) ?? new Set()
    listeners.add(listener)
    this.listeners.set(key, listeners)
    return () => {
      listeners.delete(listener)
      if (!listeners.size) this.listeners.delete(key)
    }
  }

  private update(key: string, draft: Draft): void {
    if (!draft.text && !draft.attachments.length && !draft.saving) this.drafts.delete(key)
    else this.drafts.set(key, draft)
    this.listeners.get(key)?.forEach((listener) => listener())
  }

  setText(key: string, text: string): void { this.update(key, { ...this.get(key), text }) }

  addAttachment(key: string, attachment: Attachment): void {
    const draft = this.get(key)
    this.update(key, { ...draft, attachments: [...draft.attachments, attachment] })
  }

  removeAttachment(key: string, path: string): void {
    const draft = this.get(key)
    this.update(key, { ...draft, attachments: draft.attachments.filter((attachment) => attachment.path !== path) })
  }

  startSaving(key: string, count: number): void {
    const draft = this.get(key)
    this.update(key, { ...draft, saving: draft.saving + count })
  }

  finishSaving(key: string): void {
    const draft = this.get(key)
    this.update(key, { ...draft, saving: Math.max(0, draft.saving - 1) })
  }

  /** Puts taken-back messages (cancelled or stopped queue items) into the draft, after any text there. */
  restore(key: string, items: Array<{ text: string; attachments: Attachment[] }>): void {
    if (!items.length) return
    const draft = this.get(key)
    const text = [draft.text.trimEnd(), ...items.map((item) => item.text.trim())].filter(Boolean).join('\n\n')
    const seen = new Set(draft.attachments.map((attachment) => attachment.path))
    const attachments = [...draft.attachments, ...items.flatMap((item) => item.attachments).filter((attachment) => !seen.has(attachment.path) && seen.add(attachment.path))]
    this.update(key, { ...draft, text, attachments })
  }

  /** Atomically consume a ready draft; files still saving must join this message. */
  take(key: string): Draft | undefined {
    const draft = this.get(key)
    if (draft.saving || (!draft.text.trim() && !draft.attachments.length)) return undefined
    this.update(key, EMPTY_DRAFT)
    return draft
  }
}

/** The app's drafts, shared by every composer and by actions that put text back. */
export const composerDrafts = new ComposerDrafts()

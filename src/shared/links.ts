export type LinkKind = 'web' | 'local' | 'anchor' | 'unsupported'

/** This is a UI classifier only; the main process validates paths and room boundaries. */
export function linkKind(href: string): LinkKind {
  const value = href.trim()
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return 'unsupported'
  if (value.startsWith('#')) return 'anchor'
  if (/^https?:\/\//i.test(value)) {
    try { return new URL(value).hostname ? 'web' : 'unsupported' } catch { return 'unsupported' }
  }
  if (/^file:/i.test(value)) return 'local'
  if (/^[\\/]{2}/.test(value)) return 'unsupported'
  if (/^(?:https?|data|javascript|vbscript|blob|mailto|tel|ftp|vscode|iface):/i.test(value)) return 'unsupported'
  // A filename with a line suffix is not a URI scheme (README.md:12:3).
  if (/^[^:/?#]+:\d+(?::\d+)?(?:#.*)?$/.test(value)) return 'local'
  if (/^[a-z][a-z\d+.-]*:/i.test(value)) return 'unsupported'
  return 'local'
}

export function headingId(text: string): string {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').replace(/\s+/g, '-')
}

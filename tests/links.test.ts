import { describe, expect, it } from 'vitest'
import { headingId, linkKind } from '../src/shared/links'

describe('chat link routing', () => {
  it.each([
    '/project/docs/My Script.md:12', 'docs/script.md:12:4', './src/app.ts#L42-L46',
    '../readme.md#details', 'file:///project/My%20Script.pdf#page=2',
    'file://localhost/project/image.png', 'README.md:12', 'README:12', 'LICENSE:12:3',
    '/project/report:2026.md', 'docs/বাংলা.md', '/project/a%23b.md'
  ])('routes %s to the bounded file resolver', (href) => expect(linkKind(href)).toBe('local'))

  it.each(['https://example.com/report.pdf#page=2', 'HTTP://example.com', ' https://example.com/a%20b '])(
    'keeps %s in the browser', (href) => expect(linkKind(href)).toBe('web')
  )
  it.each(['', 'javascript:alert(1)', 'javascript:123', 'data:text/html,<script>', 'vbscript:12', 'https:example.com',
    'https://', '//other-host/report.md', 'vscode://file/path', 'iface://file/path', 'mailto:user@example.com', '/path\u0000name', 'https://example.com\n/path']) (
    'rejects %s without allowing a browser navigation', (href) => expect(linkKind(href)).toBe('unsupported')
  )
  it('keeps document anchors local and provides Unicode heading ids', () => {
    expect(linkKind('#setup')).toBe('anchor')
    expect(headingId('Setup & Review')).toBe('setup-review')
    expect(headingId('বাংলা পাঠ')).toBe('বাংলা-পাঠ')
  })
})

import { Children, isValidElement, memo, useMemo, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import { Icon } from './Icon'
import { headingId, linkKind } from '@shared/links'
import { act, useApp, type LinkContext } from '../store'

function CodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    void navigator.clipboard.writeText(ref.current?.innerText ?? '')
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }
  return (
    <div className="code-block">
      <button className="code-copy" onClick={copy} title="Copy code">
        <Icon name={copied ? 'check' : 'copy'} size={13} />
      </button>
      <pre ref={ref}>{children}</pre>
    </div>
  )
}

function textOf(children: ReactNode): string {
  return Children.toArray(children).map((child) => isValidElement<{ children?: ReactNode }>(child) ? textOf(child.props.children) : String(child)).join('')
}

export const Markdown = memo(function Markdown({ text, roomId, memberId, fromFile }: { text: string } & LinkContext) {
  const container = useRef<HTMLDivElement>(null)
  const openLink = useApp((s) => s.openLink)
  const components = useMemo<Components>(() => ({
    pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
    a: ({ href, children }) => (
      <a
        href={href}
        onClick={(e) => {
          e.preventDefault()
          if (href?.startsWith('#')) {
            let id = href.slice(1)
            try { id = decodeURIComponent(id) } catch { /* let the resolver report invalid links */ }
            const heading = Array.from(container.current?.querySelectorAll('[id]') ?? []).find((element) => element.id === id)
            if (heading) { heading.scrollIntoView({ block: 'start' }); return }
          }
          void act(() => openLink(href ?? '', { roomId, memberId, fromFile }))
        }}
      >
        {children}
      </a>
    ),
    h1: ({ children }) => <h1 id={headingId(textOf(children))}>{children}</h1>,
    h2: ({ children }) => <h2 id={headingId(textOf(children))}>{children}</h2>,
    h3: ({ children }) => <h3 id={headingId(textOf(children))}>{children}</h3>,
    h4: ({ children }) => <h4 id={headingId(textOf(children))}>{children}</h4>,
    h5: ({ children }) => <h5 id={headingId(textOf(children))}>{children}</h5>,
    h6: ({ children }) => <h6 id={headingId(textOf(children))}>{children}</h6>,
    table: ({ children }) => (
      <div className="table-wrap">
        <table>{children}</table>
      </div>
    )
  }), [openLink, roomId, memberId, fromFile])
  return (
    <div className="md" ref={container}>
      <ReactMarkdown urlTransform={(url, key) => key === 'href' ? (linkKind(url) === 'unsupported' ? '' : url) : defaultUrlTransform(url)} remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
})

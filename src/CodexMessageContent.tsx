import type { ReactNode } from 'react'
import { CopyAction } from './CopyAction'

interface CodexMessageContentProps {
  text: string
}

type CodexBlock =
  | { type: 'blockquote'; lines: string[] }
  | { type: 'code'; language: string; value: string }
  | { type: 'heading'; depth: number; text: string }
  | { type: 'list'; ordered: boolean; items: Array<{ checked?: boolean; text: string }> }
  | { type: 'paragraph'; text: string }
  | { type: 'table'; headers: string[]; rows: string[][] }

function isListLine(line: string) {
  return /^(\s*)([-*+])\s+/.test(line) || /^(\s*)\d+[.)]\s+/.test(line)
}

function isHeadingLine(line: string) {
  return /^(#{1,4})\s+/.test(line)
}

function isBlockquoteLine(line: string) {
  return /^>\s?/.test(line)
}

function isTableDivider(line: string) {
  return /^\s*\|?[\s:-]+\|[\s|:-]*\s*$/.test(line) && line.includes('-')
}

function splitTableRow(line: string) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

function parseBlocks(text: string): CodexBlock[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: CodexBlock[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index] || ''
    if (!line.trim()) {
      index += 1
      continue
    }

    const fence = line.match(/^```([\w-]*)\s*$/)
    if (fence) {
      const language = fence[1] || ''
      const value: string[] = []
      index += 1
      while (index < lines.length && !/^```\s*$/.test(lines[index] || '')) {
        value.push(lines[index] || '')
        index += 1
      }
      if (index < lines.length) index += 1
      blocks.push({ type: 'code', language, value: value.join('\n') })
      continue
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/)
    if (heading) {
      blocks.push({
        type: 'heading',
        depth: heading[1].length,
        text: heading[2].trim(),
      })
      index += 1
      continue
    }

    if (
      line.includes('|') &&
      lines[index + 1]?.includes('|') &&
      isTableDivider(lines[index + 1] || '')
    ) {
      const headers = splitTableRow(line)
      const rows: string[][] = []
      index += 2
      while (index < lines.length && (lines[index] || '').includes('|')) {
        rows.push(splitTableRow(lines[index] || ''))
        index += 1
      }
      blocks.push({ type: 'table', headers, rows })
      continue
    }

    if (isBlockquoteLine(line)) {
      const quoteLines: string[] = []
      while (index < lines.length && isBlockquoteLine(lines[index] || '')) {
        quoteLines.push((lines[index] || '').replace(/^>\s?/, ''))
        index += 1
      }
      blocks.push({ type: 'blockquote', lines: quoteLines })
      continue
    }

    if (isListLine(line)) {
      const ordered = /^(\s*)\d+[.)]\s+/.test(line)
      const items: Array<{ checked?: boolean; text: string }> = []
      while (index < lines.length && isListLine(lines[index] || '')) {
        const itemText = (lines[index] || '')
          .replace(/^(\s*)([-*+]|\d+[.)])\s+/, '')
          .trim()
        const checkedMatch = itemText.match(/^\[( |x|X)\]\s+(.+)$/)
        items.push(
          checkedMatch
            ? {
                checked: checkedMatch[1].toLowerCase() === 'x',
                text: checkedMatch[2],
              }
            : { text: itemText },
        )
        index += 1
      }
      blocks.push({ type: 'list', ordered, items })
      continue
    }

    const paragraphLines: string[] = []
    while (
      index < lines.length &&
      lines[index]?.trim() &&
      !/^```/.test(lines[index] || '') &&
      !isHeadingLine(lines[index] || '') &&
      !isBlockquoteLine(lines[index] || '') &&
      !isListLine(lines[index] || '')
    ) {
      if (
        (lines[index] || '').includes('|') &&
        lines[index + 1]?.includes('|') &&
        isTableDivider(lines[index + 1] || '')
      ) {
        break
      }
      paragraphLines.push(lines[index] || '')
      index += 1
    }
    blocks.push({ type: 'paragraph', text: paragraphLines.join('\n') })
  }

  return blocks
}

function safeHref(value: string) {
  const trimmed = value.trim()
  if (/^(https?:|mailto:|\/(?!\/))/i.test(trimmed)) return trimmed
  return ''
}

function renderInline(text: string): ReactNode[] {
  const pattern =
    /(`[^`]+`|\*\*[^*]+\*\*|~~[^~]+~~|\[[^\]]+\]\([^)]+\)|\*[^*]+\*)/g
  const nodes: ReactNode[] = []
  let lastIndex = 0

  for (const match of text.matchAll(pattern)) {
    const token = match[0]
    const offset = match.index || 0
    if (offset > lastIndex) nodes.push(text.slice(lastIndex, offset))
    lastIndex = offset + token.length

    if (token.startsWith('`')) {
      nodes.push(<code key={`${offset}-code`}>{token.slice(1, -1)}</code>)
      continue
    }
    if (token.startsWith('**')) {
      nodes.push(<strong key={`${offset}-strong`}>{renderInline(token.slice(2, -2))}</strong>)
      continue
    }
    if (token.startsWith('~~')) {
      nodes.push(<s key={`${offset}-strike`}>{renderInline(token.slice(2, -2))}</s>)
      continue
    }
    if (token.startsWith('[')) {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
      const href = link ? safeHref(link[2]) : ''
      nodes.push(
        href ? (
          <a key={`${offset}-link`} href={href} rel="noreferrer" target="_blank">
            {renderInline(link?.[1] || '')}
          </a>
        ) : (
          token
        ),
      )
      continue
    }
    if (token.startsWith('*')) {
      nodes.push(<em key={`${offset}-em`}>{renderInline(token.slice(1, -1))}</em>)
    }
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex))
  return nodes
}

function CodexCodeBlock({ language, value }: { language: string; value: string }) {
  return (
    <figure className="codex-rich-code">
      <figcaption>
        <span>{language || 'code'}</span>
        <CopyAction
          className="codex-code-copy-action"
          label="Copy code"
          size={13}
          value={value}
        />
      </figcaption>
      <pre>
        <code>{value}</code>
      </pre>
    </figure>
  )
}

export function CodexMessageContent({ text }: CodexMessageContentProps) {
  const blocks = parseBlocks(text)

  return (
    <div className="codex-rich-message">
      {blocks.map((block, index) => {
        if (block.type === 'code') {
          return (
            <CodexCodeBlock
              key={`code-${index}`}
              language={block.language}
              value={block.value}
            />
          )
        }

        if (block.type === 'heading') {
          const Tag = `h${Math.min(block.depth + 2, 6)}` as 'h3' | 'h4' | 'h5' | 'h6'
          return <Tag key={`heading-${index}`}>{renderInline(block.text)}</Tag>
        }

        if (block.type === 'blockquote') {
          return (
            <blockquote key={`quote-${index}`}>
              {block.lines.map((line, lineIndex) => (
                <p key={`quote-line-${lineIndex}`}>{renderInline(line)}</p>
              ))}
            </blockquote>
          )
        }

        if (block.type === 'list') {
          const ListTag = block.ordered ? 'ol' : 'ul'
          return (
            <ListTag key={`list-${index}`}>
              {block.items.map((item, itemIndex) => (
                <li key={`item-${itemIndex}`}>
                  {typeof item.checked === 'boolean' && (
                    <input type="checkbox" checked={item.checked} readOnly tabIndex={-1} />
                  )}
                  <span>{renderInline(item.text)}</span>
                </li>
              ))}
            </ListTag>
          )
        }

        if (block.type === 'table') {
          return (
            <div className="codex-rich-table-wrap" key={`table-${index}`}>
              <table>
                <thead>
                  <tr>
                    {block.headers.map((header, headerIndex) => (
                      <th key={`header-${headerIndex}`}>{renderInline(header)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={`row-${rowIndex}`}>
                      {block.headers.map((_, cellIndex) => (
                        <td key={`cell-${cellIndex}`}>
                          {renderInline(row[cellIndex] || '')}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }

        return (
          <p key={`paragraph-${index}`}>
            {block.text.split('\n').map((line, lineIndex) => (
              <span key={`line-${lineIndex}`}>
                {lineIndex > 0 && <br />}
                {renderInline(line)}
              </span>
            ))}
          </p>
        )
      })}
    </div>
  )
}

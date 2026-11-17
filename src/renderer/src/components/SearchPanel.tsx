/** 搜索面板 —— 全文检索（MiniSearch）+ 标签页切换 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { SearchHit } from '../../../shared/types.js'

interface Props {
  onOpen: (relPath: string) => void
  onClose: () => void
}

type Tab = 'lexical' | 'semantic'

export function SearchPanel({ onOpen, onClose }: Props): React.JSX.Element {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [semantic, setSemantic] = useState<SearchHit[]>([])
  const [tab, setTab] = useState<Tab>('lexical')
  const [tookMs, setTookMs] = useState(0)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const timer = useRef<number | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const run = useCallback(async (text: string) => {
    if (!text.trim()) {
      setHits([])
      setSemantic([])
      return
    }
    setBusy(true)
    const r = await window.qn.search.query(text)
    setBusy(false)
    if (r.ok) {
      setHits(r.data.lexical)
      setSemantic(r.data.semantic)
      setTookMs(r.data.tookMs)
    }
  }, [])

  const onChange = (v: string): void => {
    setQ(v)
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => void run(v), 120)
  }

  const list = tab === 'lexical' ? hits : semantic

  return (
    <div className="search-overlay">
      <div className="search-head">
        <input
          ref={inputRef}
          className="search-input"
          placeholder="搜索全部笔记…（回车打开第一项，Esc 关闭）"
          value={q}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
            if (e.key === 'Enter' && list[0]) onOpen(list[0].relPath)
          }}
        />
        <button className="btn ghost small" onClick={onClose}>
          关闭
        </button>
      </div>
      <div className="search-tabs">
        <button className="tab" data-active={tab === 'lexical'} onClick={() => setTab('lexical')}>
          全文 {hits.length > 0 && `(${hits.length})`}
        </button>
        <button className="tab" data-active={tab === 'semantic'} onClick={() => setTab('semantic')}>
          相关 {semantic.length > 0 && `(${semantic.length})`}
        </button>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-meta)', alignSelf: 'center' }}>
          {busy ? '搜索中…' : `${tookMs} ms`}
        </span>
      </div>
      <div className="search-results">
        {!q.trim() && <div className="empty" style={{ padding: 24 }}>输入关键字开始搜索</div>}
        {q.trim() && list.length === 0 && !busy && (
          <div className="empty" style={{ padding: 24 }}>
            {tab === 'semantic' ? '语义检索需要启用本地 AI 与 embedding 模型' : '没有找到匹配的笔记'}
          </div>
        )}
        {list.map((h) => (
          <button key={`${h.source}:${h.relPath}`} className="hit" onClick={() => onOpen(h.relPath)}>
            <div className="hit-title">{h.title || h.relPath}</div>
            <div className="hit-snip">{highlight(h.snippet, q)}</div>
            <div className="hit-path">{h.relPath}</div>
          </button>
        ))}
      </div>
    </div>
  )
}

function highlight(text: string, q: string): React.ReactNode {
  const term = q.trim().split(/\s+/)[0]
  if (!term) return text
  const idx = text.toLowerCase().indexOf(term.toLowerCase())
  if (idx === -1) return text
  return (
    <>
      {text.slice(0, idx)}
      <mark>{text.slice(idx, idx + term.length)}</mark>
      {text.slice(idx + term.length)}
    </>
  )
}

/** 主面板 App —— 组装目录树 / 编辑器 / 预览 / 搜索 / 标签 / AI / 设置 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppConfig, DirNode, NoteContent } from '../../../shared/types.js'
import { useCodeMirror, type EditorApi } from './useCodeMirror'
import { countWords, extractOutline, renderMarkdown } from './markdown'
import { TreeView } from './TreeView'
import { SearchPanel } from './SearchPanel'
import { SettingsPanel } from './SettingsPanel'
import { AiPanel } from './AiPanel'
import { Onboarding } from './Onboarding'

type Layout = 'single' | 'vertical' | 'horizontal'
type SaveState = 'saved' | 'saving' | 'unsaved'
type Route = 'note' | 'search' | 'settings' | 'onboarding'

function layoutFor(width: number, pref: AppConfig['panel']['layout']): Layout {
  if (pref !== 'auto') return pref
  if (width < 520) return 'single'
  if (width <= 900) return 'vertical'
  return 'horizontal'
}

export function App(): React.JSX.Element {
  const [cfg, setCfg] = useState<AppConfig | null>(null)
  const [tree, setTree] = useState<DirNode | null>(null)
  const [current, setCurrent] = useState<NoteContent | null>(null)
  const [body, setBody] = useState('')
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [cursor, setCursor] = useState({ line: 1, col: 1 })
  const [route, setRoute] = useState<Route>('note')
  const [showPreview, setShowPreview] = useState(true)
  const [width, setWidth] = useState(480)
  const [toasts, setToasts] = useState<Array<{ id: number; level: string; text: string }>>([])
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [gotoLine, setGotoLine] = useState<{ line: number; nonce: number } | null>(null)
  const [aiOpen, setAiOpen] = useState(false)
  const [previewHtml, setPreviewHtml] = useState('')
  const [tagFilter, setTagFilter] = useState<string | null>(null)

  const saveTimer = useRef<number | null>(null)
  const debounceRef = useRef<number>(120)
  const renderTimes = useRef<number[]>([])
  const unsavedRef = useRef(false)

  const pushToast = useCallback((level: string, text: string): void => {
    if (!text) return
    const id = Date.now() + Math.random()
    setToasts((t) => [...t.slice(-2), { id, level, text }])
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3600)
  }, [])

  /* ---- 初始化 ---- */
  useEffect(() => {
    void (async () => {
      const r = await window.qn.config.get()
      if (r.ok) {
        setCfg(r.data)
        setWidth(r.data.panel.width)
        setRoute(r.data.onboardingDone ? 'note' : 'onboarding')
      }
      const w = await window.qn.window.panelGetBounds()
      if (w.ok && w.data) setWidth(w.data.width)
      const t = await window.qn.notes.listTree()
      if (t.ok) setTree(t.data)
    })()
  }, [])

  /* ---- 宽度自适应 ---- */
  useEffect(() => {
    const onResize = (): void => setWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    onResize()
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const layout = useMemo(() => (cfg ? layoutFor(width, cfg.panel.layout) : 'single'), [width, cfg])

  /* ---- 事件订阅 ---- */
  useEffect(() => {
    const off1 = window.qn.events.onFileChanged((p) => {
      void (async () => {
        const t = await window.qn.notes.listTree()
        if (t.ok) setTree(t.data)
        if (current && p.relPath === current.relPath && p.evt === 'change') {
          pushToast('warn', '这个文件已在外部被修改，可按 Ctrl+S 覆盖或重新打开。')
        }
      })()
    })
    const off2 = window.qn.events.onToast((p) => {
      if (p.route === 'settings') setRoute('settings')
      if (p.route === 'open' && p.relPath) void openNote(p.relPath)
      if (p.text) pushToast(p.level, p.text)
    })
    const off3 = window.qn.events.onConfigChanged((c) => setCfg(c))
    const off4 = window.qn.events.onRootChanged(() => {
      void (async () => {
        const t = await window.qn.notes.listTree()
        if (t.ok) setTree(t.data)
        setCurrent(null)
        setBody('')
      })()
    })
    return () => {
      off1()
      off2()
      off3()
      off4()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, pushToast])

  /* ---- 打开笔记 ---- */
  const openNote = useCallback(
    async (rel: string) => {
      const r = await window.qn.notes.read(rel)
      if (!r.ok) {
        pushToast('error', `打开失败：${r.error.message}`)
        return
      }
      setCurrent(r.data)
      setBody(r.data.body)
      setSaveState('saved')
      unsavedRef.current = false
      window.qn.window.setUnsaved(false)
      setRoute('note')
      void window.qn.config.patch({
        recent: [
          { path: rel, openedAt: new Date().toISOString() },
          ...(cfg?.recent ?? []).filter((x) => x.path !== rel)
        ].slice(0, 20)
      })
    },
    [cfg?.recent, pushToast]
  )

  /* ---- 保存 ---- */
  const doSave = useCallback(async () => {
    if (!current) return
    setSaveState('saving')
    const r = await window.qn.notes.write(current.relPath, body, current.eol)
    if (r.ok) {
      setSaveState('saved')
      unsavedRef.current = false
      window.qn.window.setUnsaved(false)
      const t = await window.qn.notes.listTree()
      if (t.ok) setTree(t.data)
    } else {
      setSaveState('unsaved')
      pushToast('error', `保存失败：${r.error.message}`)
    }
  }, [current, body, pushToast])

  /* ---- 编辑变更：防抖保存 + 自适应预览 ---- */
  const onBodyChange = useCallback(
    (v: string) => {
      setBody(v)
      setSaveState('unsaved')
      unsavedRef.current = true
      window.qn.window.setUnsaved(true)

      const delay = cfg?.editor.autoSaveDelayMs ?? 800
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(() => {
        void doSave()
      }, delay)

      // 自适应预览防抖（FR-3.2）
      const t0 = performance.now()
      const html = renderMarkdown(v)
      const took = performance.now() - t0
      renderTimes.current = [...renderTimes.current.slice(-4), took]
      const sorted = [...renderTimes.current].sort((a, b) => a - b)
      const median = sorted[Math.floor(sorted.length / 2)] ?? 20
      const win = median <= 40 ? 120 : median <= 120 ? Math.min(400, Math.round(median * 3)) : 400
      debounceRef.current = win
      if (win >= 400) {
        pushToast('info', '低配模式：预览稍慢')
      }
      setPreviewHtml(html)
    },
    [cfg?.editor.autoSaveDelayMs, doSave, pushToast]
  )

  /* ---- 编辑器 ---- */
  const { hostRef, apiRef } = useCodeMirror({
    initialValue: body,
    onChange: onBodyChange,
    onCursor: (line, col) => setCursor({ line, col }),
    onSave: () => void doSave(),
    onPasteImage: async () => {
      if (!current) return null
      const r = await window.qn.clipboard.saveImage(current.relPath)
      if (!r.ok) {
        pushToast('error', `图片保存失败：${r.error.message}`)
        return null
      }
      if (!r.data) {
        pushToast('warn', '剪贴板里没有图片')
        return null
      }
      pushToast('info', '图片已保存到 assets/')
      return r.data
    },
    gotoLine,
    readOnly: route !== 'note'
  })

  // 切换笔记时重置编辑器内容
  const lastOpened = useRef<string | null>(null)
  useEffect(() => {
    if (!current) return
    if (lastOpened.current === current.relPath) return
    lastOpened.current = current.relPath
    apiRef.current?.setValue(current.body)
    setPreviewHtml(renderMarkdown(current.body))
  }, [current, apiRef])

  /* ---- 新建 ---- */
  const newNote = useCallback(async () => {
    const r = await window.qn.notes.create()
    if (!r.ok) {
      pushToast('error', `新建失败：${r.error.message}`)
      return
    }
    const t = await window.qn.notes.listTree()
    if (t.ok) setTree(t.data)
    await openNote(r.data.relPath)
    window.setTimeout(() => {
      apiRef.current?.focus()
      apiRef.current?.scrollToLine(1)
    }, 60)
  }, [openNote, apiRef, pushToast])

  /* ---- 删除 ---- */
  const deleteNote = useCallback(
    async (rel: string) => {
      if (!window.confirm(`确定把「${rel}」移到回收站吗？\n（可在笔记目录的 .trash 里找回）`)) return
      const r = await window.qn.notes.delete(rel)
      if (!r.ok) {
        pushToast('error', `删除失败：${r.error.message}`)
        return
      }
      pushToast('info', '已移到回收站')
      if (current?.relPath === rel) {
        setCurrent(null)
        setBody('')
      }
      const t = await window.qn.notes.listTree()
      if (t.ok) setTree(t.data)
    },
    [current?.relPath, pushToast]
  )

  /* ---- 重命名 ---- */
  const renameNote = useCallback(
    async (rel: string, oldName: string) => {
      const next = window.prompt('新的笔记名称（不需要 .md）', oldName)
      if (!next || next === oldName) return
      const r = await window.qn.notes.rename(rel, next)
      if (!r.ok) {
        pushToast('error', `重命名失败：${r.error.message}`)
        return
      }
      const t = await window.qn.notes.listTree()
      if (t.ok) setTree(t.data)
      if (current?.relPath === rel) {
        setCurrent({ ...current, relPath: r.data.relPath })
      }
    },
    [current, pushToast]
  )

  /* ---- 快捷键 ---- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      if (!mod) {
        if (e.key === 'Escape') {
          if (aiOpen) setAiOpen(false)
          else if (route === 'search') setRoute('note')
        }
        return
      }
      if (e.key === 'n') {
        e.preventDefault()
        void newNote()
      } else if (e.key === 'f') {
        e.preventDefault()
        setRoute('search')
      } else if (e.key === ',') {
        e.preventDefault()
        setRoute('settings')
      } else if (e.key === 'e') {
        e.preventDefault()
        setShowPreview((v) => !v)
      } else if (e.key === 's') {
        e.preventDefault()
        void doSave()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [newNote, doSave, aiOpen, route])

  const outline = useMemo(() => extractOutline(body), [body])
  const stats = useMemo(() => countWords(body), [body])
  const rootPath = cfg?.noteRoot ?? ''

  if (!cfg) {
    return <div className="empty">载入中…</div>
  }

  if (route === 'onboarding') {
    return (
      <Onboarding
        onDone={async (dir) => {
          const r = await window.qn.root.set(dir)
          if (r.ok) {
            const c = await window.qn.config.get()
            if (c.ok) setCfg(c.data)
            setRoute('note')
            const t = await window.qn.notes.listTree()
            if (t.ok) setTree(t.data)
          }
        }}
      />
    )
  }

  const bodyLayout = layout

  return (
    <div className="panel">
      <div className="titlebar">
        <span className="brand">{current ? current.relPath.replace(/\.md$/, '') : '随手笔记'}</span>
        <button className="icon-btn no-drag" title="新建笔记 (Ctrl+N)" onClick={() => void newNote()}>
          ＋
        </button>
        <button className="icon-btn no-drag" title="搜索 (Ctrl+F)" onClick={() => setRoute('search')}>
          🔍
        </button>
        <button
          className="icon-btn no-drag"
          data-active={outlineOpen}
          title="大纲 (Ctrl+Shift+O)"
          onClick={() => setOutlineOpen((v) => !v)}
        >
          ☰
        </button>
        <button
          className="icon-btn no-drag"
          data-active={aiOpen}
          title="本地 AI"
          onClick={() => setAiOpen((v) => !v)}
        >
          ✦
        </button>
        <button className="icon-btn no-drag" title="设置 (Ctrl+,)" onClick={() => setRoute('settings')}>
          ⚙
        </button>
      </div>

      <div className="body" data-layout={bodyLayout} style={{ position: 'relative' }}>
        {(layout === 'horizontal' || layout === 'vertical' || layout === 'single') && (
          <aside className="sidebar">
            <div className="sidebar-head">
              <span>笔记</span>
              <span style={{ marginLeft: 'auto', fontSize: 11 }}>{tree ? countNotes(tree) : 0}</span>
            </div>
            {tagFilter && (
              <div style={{ padding: '0 8px 6px' }}>
                <button className="tag-chip" data-active="true" onClick={() => setTagFilter(null)}>
                  #{tagFilter} ×
                </button>
              </div>
            )}
            <div className="sidebar-scroll">
              {tree && (
                <TreeView
                  node={tree}
                  selected={current?.relPath ?? null}
                  tagFilter={tagFilter}
                  onOpen={(rel) => void openNote(rel)}
                  onDelete={(rel) => void deleteNote(rel)}
                  onRename={(rel, name) => void renameNote(rel, name)}
                />
              )}
            </div>
            {outlineOpen && outline.length > 0 && (
              <>
                <div className="sidebar-head" style={{ borderTop: '1px solid var(--border)' }}>
                  <span>大纲</span>
                </div>
                <div className="sidebar-scroll" style={{ flex: '0 1 auto', maxHeight: 200 }}>
                  {outline.map((o, i) => (
                    <button
                      key={i}
                      className="outline-item"
                      style={{ paddingLeft: 8 + (o.level - 1) * 10 }}
                      onClick={() => setGotoLine({ line: o.line, nonce: Date.now() })}
                      title={`第 ${o.line} 行`}
                    >
                      {o.text}
                    </button>
                  ))}
                </div>
              </>
            )}
          </aside>
        )}

        <div className="editor-area">
          {current ? (
            <>
              <div className="editor-pane" data-hidden={layout === 'single' && showPreview}>
                <div className="cm-host" ref={hostRef} />
              </div>
              {showPreview && (
                <div className="preview-pane" data-hidden={false}>
                  <div className="md" dangerouslySetInnerHTML={{ __html: previewHtml }} />
                </div>
              )}
            </>
          ) : (
            <div className="empty">
              <h2>开始记录</h2>
              <p>点左上角「＋」新建一篇，或按 Ctrl+N。笔记存成纯 .md 文件，随时能用别的编辑器打开。</p>
              <button className="btn" onClick={() => void newNote()}>
                ＋ 新建笔记
              </button>
            </div>
          )}
        </div>

        {route === 'search' && <SearchPanel onOpen={(rel) => void openNote(rel)} onClose={() => setRoute('note')} />}
        {route === 'settings' && (
          <SettingsPanel
            cfg={cfg}
            onClose={() => setRoute('note')}
            onChange={async (patch) => {
              const r = await window.qn.config.patch(patch)
              if (r.ok) setCfg(r.data)
            }}
            pushToast={pushToast}
            onTagClick={(t) => {
              setTagFilter(t)
              setRoute('note')
            }}
          />
        )}

        {aiOpen && current && (
          <AiPanel
            cfg={cfg}
            body={body}
            selection={() => apiRef.current?.getSelection() ?? ''}
            cursorBefore={() => {
              const c = apiRef.current?.getCursor()
              if (!c) return ''
              const lines = body.split('\n')
              return lines.slice(0, c.line).join('\n')
            }}
            onApply={(text, mode) => {
              const api: EditorApi | null = apiRef.current
              if (!api) return
              if (mode === 'replace') api.replaceSelection(text)
              else api.insertText(`\n${text}`)
            }}
            onClose={() => setAiOpen(false)}
            pushToast={pushToast}
          />
        )}
      </div>

      <div className="statusbar">
        <span>
          <span className="status-dot" data-s={saveState} />
          {saveState === 'saved' ? '已保存' : saveState === 'saving' ? '保存中…' : '未保存'}
        </span>
        <span>{stats.words} 字</span>
        <span>{stats.chars} 字符</span>
        <span>
          第 {cursor.line} 行 第 {cursor.col} 列
        </span>
        <span className="grow path-box" title={rootPath}>
          {rootPath}
        </span>
      </div>

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className="toast" data-level={t.level}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  )
}

function countNotes(node: DirNode): number {
  let n = 0
  const walk = (x: DirNode): void => {
    for (const c of x.children ?? []) {
      if (c.type === 'file') n++
      else walk(c)
    }
  }
  walk(node)
  return n
}

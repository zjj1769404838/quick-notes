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
import { InlineDialog, type ConfirmOptions, type PromptOptions } from './InlineDialog'

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
  // 单栏模式下默认进「编辑」：新建笔记后最需要的是写作区，空预览会让人以为没打开
  const [showPreview, setShowPreview] = useState(false)
  const [splitRatio, setSplitRatio] = useState(0.5)
  const [width, setWidth] = useState(480)
  const [toasts, setToasts] = useState<Array<{ id: number; level: string; text: string }>>([])
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [gotoLine, setGotoLine] = useState<{ line: number; nonce: number } | null>(null)
  const [aiOpen, setAiOpen] = useState(false)
  const [previewHtml, setPreviewHtml] = useState('')
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [dialog, setDialog] = useState<
    | { mode: 'confirm'; options: ConfirmOptions; resolve: (v: boolean) => void }
    | { mode: 'prompt'; options: PromptOptions; resolve: (v: string | null) => void }
    | null
  >(null)
  // 内联对话框：替代原生 confirm/prompt，避免面板失焦被收起（docs/05 §4 U1）
  const askConfirm = useCallback((options: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      // 弹窗期间锁住「失焦收起」，否则用户点按钮时面板会消失
      window.qn.window.setUnsaved(true)
      setDialog({
        mode: 'confirm',
        options,
        resolve: (v) => {
          window.qn.window.setUnsaved(false)
          setDialog(null)
          resolve(v)
        }
      })
    })
  }, [])
  const askPrompt = useCallback((options: PromptOptions): Promise<string | null> => {
    return new Promise<string | null>((resolve) => {
      window.qn.window.setUnsaved(true)
      setDialog({
        mode: 'prompt',
        options,
        resolve: (v) => {
          window.qn.window.setUnsaved(false)
          setDialog(null)
          resolve(v)
        }
      })
    })
  }, [])

  const saveTimer = useRef<number | null>(null)
  // 编辑器实例 ref 之外再留一份最新正文，供无法访问编辑器时的兜底保存使用
  const bodyRef = useRef<string>('')
  // flush 回调在组件外触发，需要 ref 读取当前上下文
  const currentRelRef = useRef<string | null>(null)
  const currentEolRef = useRef<'lf' | 'crlf' | null>(null)
  const currentFmRef = useRef<string | null>(null)
  const debounceRef = useRef<number>(120)
  const previewTimer = useRef<number | null>(null)
  const lowEndNotified = useRef(false)
  // 拖拽回调里需要读取最新布局与配置，用 ref 避免闭包陈旧
  const bodyLayoutRef = useRef<string>('single')
  const configRef = useRef<AppConfig | null>(null)
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
        setSplitRatio(r.data.panel.splitRatio ?? 0.5)
        setRoute(r.data.onboardingDone ? 'note' : 'onboarding')
      }
      const w = await window.qn.window.panelGetBounds()
      if (w.ok && w.data) setWidth(w.data.width)
      const t = await window.qn.notes.listTree()
      if (t.ok) setTree(t.data)
    })()
  }, [])

  /* ---- 字号应用：设置里的字号要真的作用到编辑器/预览 ---- */
  useEffect(() => {
    if (!cfg) return
    document.documentElement.style.setProperty('--fs-body', cfg.editor.fontSize + 'px')
  }, [cfg?.editor.fontSize])

  /* ---- 主题应用（FR-8）：配置里的 theme 必须真的落到 DOM，否则设置项是摆设 ---- */
  useEffect(() => {
    if (!cfg) return
    const root = document.documentElement
    const apply = (): void => {
      if (cfg.theme === 'system') delete root.dataset.theme
      else root.dataset.theme = cfg.theme
    }
    apply()
    if (cfg.theme !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => apply()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [cfg?.theme])

  /* ---- 宽度自适应 ---- */
  useEffect(() => {
    const onResize = (): void => setWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    onResize()
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const layout = useMemo(() => (cfg ? layoutFor(width, cfg.panel.layout) : 'single'), [width, cfg])
  bodyLayoutRef.current = layout
  configRef.current = cfg

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
      if (p.route === 'open' && p.relPath) void openNoteRef.current(p.relPath)
      if (p.text) pushToast(p.level, p.text)
    })
    // 主进程退出/隐藏前会请求 flush：此刻必须把内存里的最新正文落盘，
    // 否则 800ms 防抖窗口内的最后一笔输入会随窗口销毁而丢失。
    const offFlush = window.qn.events.onFlushSave(() => {
      void (async () => {
        try {
          const live = apiRef.current?.getValue()
          const rel = currentRelRef.current
          if (rel && live !== undefined && currentEolRef.current) {
            await window.qn.notes.write(rel, live, currentEolRef.current, currentFmRef.current ?? undefined)
          }
        } finally {
          window.qn.flush.done()
        }
      })()
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
      offFlush()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, pushToast])

  /* ---- 打开笔记 ---- */
  // 用 ref 持有 openNote，供事件回调使用：
  // 事件订阅的 useEffect 在 openNote 之前声明，直接引用会触发暂时性死区 ReferenceError。
  const openNoteRef = useRef<(rel: string) => Promise<void>>(async () => undefined)
  const openNote = useCallback(
    async (rel: string) => {
      const r = await window.qn.notes.read(rel)
      if (!r.ok) {
        pushToast('error', `打开失败：${r.error.message}`)
        return
      }
      setCurrent(r.data)
      currentRelRef.current = r.data.relPath
      currentEolRef.current = r.data.eol
      currentFmRef.current = r.data.rawFrontmatter
      setBody(r.data.body)
      setSaveState('saved')
      unsavedRef.current = false
      window.qn.window.setUnsaved(false)
      setRoute('note')
      // 打开后聚焦编辑器，否则用户直接打字会丢（docs/05 §4 U4）
      window.setTimeout(() => apiRef.current?.focus(), 80)
      void window.qn.config.patch({
        recent: [
          { path: rel, openedAt: new Date().toISOString() },
          ...(cfg?.recent ?? []).filter((x) => x.path !== rel)
        ].slice(0, 20)
      })
    },
    [cfg?.recent, pushToast]
  )
  openNoteRef.current = openNote

  /* ---- 分栏拖拽（FR-3.3） ---- */
  const onSplitterDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const area = (e.currentTarget as HTMLElement).parentElement
    if (!area) return
    const horizontal = bodyLayoutRef.current === 'horizontal'
    const move = (ev: MouseEvent): void => {
      const rect = area.getBoundingClientRect()
      const ratio = horizontal
        ? (ev.clientX - rect.left) / rect.width
        : (ev.clientY - rect.top) / rect.height
      setSplitRatio(Math.max(0.2, Math.min(0.8, ratio)))
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.style.cursor = ''
      setSplitRatio((r) => {
        const base = configRef.current?.panel
        if (base) void window.qn.config.patch({ panel: { ...base, splitRatio: r } })
        return r
      })
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    document.body.style.cursor = horizontal ? 'col-resize' : 'row-resize'
  }, [])

  const resetSplit = useCallback(() => {
    setSplitRatio(0.5)
    const base = configRef.current?.panel
    if (base) void window.qn.config.patch({ panel: { ...base, splitRatio: 0.5 } })
  }, [])

  /* ---- 保存 ---- */
  const doSave = useCallback(async () => {
    if (!current) return
    // 关键：从编辑器实时取值，不用 React state 闭包。
    // 自动保存的 setTimeout 捕获的是「设置定时器那一刻」的 body，
    // 若用闭包快照，最后一笔输入会被静默丢弃却仍显示「已保存」。
    const live = apiRef.current?.getValue()
    const payload = live ?? bodyRef.current
    setSaveState('saving')
    // 第 4 参必须回传原始 frontmatter：read() 已剥离它，若不带回会整块删掉用户的 YAML
    const r = await window.qn.notes.write(current.relPath, payload, current.eol, current.rawFrontmatter ?? undefined)
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
  }, [current, pushToast])

  /* ---- 编辑变更：防抖保存 + 自适应预览 ---- */
  const onBodyChange = useCallback(
    (v: string) => {
      setBody(v)
      bodyRef.current = v
      setSaveState('unsaved')
      unsavedRef.current = true
      window.qn.window.setUnsaved(true)

      const delay = cfg?.editor.autoSaveDelayMs ?? 800
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(() => {
        void doSave()
      }, delay)

      // 自适应预览防抖（FR-3.2）
      // 关键：渲染不能在按键回调里同步跑（markdown-it + DOMPurify 对长文可达数十 ms，
      // 会直接吃掉帧预算），必须延后到窗口期结束后执行。窗口值由实测耗时自适应收敛。
      if (previewTimer.current) window.clearTimeout(previewTimer.current)
      previewTimer.current = window.setTimeout(() => {
        const t0 = performance.now()
        const html = renderMarkdown(v)
        const took = performance.now() - t0
        renderTimes.current = [...renderTimes.current.slice(-4), took]
        const sorted = [...renderTimes.current].sort((a, b) => a - b)
        const median = sorted[Math.floor(sorted.length / 2)] ?? 20
        const win = median <= 40 ? 120 : median <= 120 ? Math.min(400, Math.round(median * 3)) : 400
        debounceRef.current = win
        if (win >= 400 && !lowEndNotified.current) {
          lowEndNotified.current = true
          pushToast('info', '低配模式：预览稍慢')
        }
        setPreviewHtml(html)
      }, debounceRef.current)
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
    readOnly: route !== 'note',
    mountKey: current?.relPath ?? null
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
      const okDel = await askConfirm({
        title: '移到回收站？',
        detail: `「${rel}」会被移到笔记目录的 .trash 下，之后可以在那里找回。`,
        confirmText: '移到回收站',
        tone: 'danger'
      })
      if (!okDel) return
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
    [current?.relPath, pushToast, askConfirm]
  )

  /* ---- 重命名 ---- */
  const renameNote = useCallback(
    async (rel: string, oldName: string) => {
      const next = await askPrompt({
        title: '重命名',
        detail: '不需要输入 .md 后缀',
        defaultValue: oldName,
        confirmText: '重命名'
      })
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
    [current, pushToast, askPrompt]
  )

  /* ---- 快捷键 ---- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      if (!mod) {
        if (e.key === 'Escape') {
          if (aiOpen) setAiOpen(false)
          else if (route === 'search' || route === 'settings') setRoute('note')
          // 回到笔记页再按一次 Esc → 收起面板（键盘用户原先无路可退）
          else if (route === 'note') void window.qn.window.panelHide()
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

  // 标签过滤：原先 tagFilter 只是显示一个 chip，树完全没过滤（docs/05 §4 U2）
  // 这里在索引里查出含该标签的路径集合，再交给树过滤。
  // 单栏下目录树常驻会占掉 260px，写作区只剩一半 —— 默认折成一行（docs/05 §4 U8）
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [tagPaths, setTagPaths] = useState<Set<string> | null>(null)
  useEffect(() => {
    if (!tagFilter) {
      setTagPaths(null)
      return
    }
    void (async () => {
      const r = await window.qn.search.query(tagFilter, 500)
      if (!r.ok) return
      const set = new Set<string>()
      for (const h of r.data.lexical) {
        if (h.tags.some((t) => t.toLowerCase() === tagFilter.toLowerCase())) set.add(h.relPath)
      }
      setTagPaths(set)
    })()
  }, [tagFilter])

  // 冷启动不该回到空白：把最近打开的一篇摆在最显眼处（docs/05 §4 U3）
  const recentList = useMemo(() => {
    const list = (cfg?.recent ?? []).filter((r) => r && r.path)
    return list.slice(0, 5)
  }, [cfg?.recent])
  const prettyName = (rel: string): string =>
    rel.replace(/\.md$/i, '').split('/').pop() ?? rel
  const prettyTime = (iso: string): string => {
    try {
      const d = new Date(iso)
      const now = new Date()
      const sameDay = d.toDateString() === now.toDateString()
      const p2 = (n: number): string => String(n).padStart(2, "0")
      return sameDay
        ? `${p2(d.getHours())}:${p2(d.getMinutes())}`
        : `${d.getMonth() + 1}/${d.getDate()}`
    } catch {
      return ""
    }
  }
  // 打开最近项：路径可能已不存在，失败要能提示而不是静默
  const openItem = useCallback(
    async (rel: string) => {
      await openNote(rel)
    },
    [openNote]
  )

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
        <button
          className="icon-btn no-drag"
          title="收起面板 (Esc)"
          aria-label="收起面板"
          onClick={() => void window.qn.window.panelHide()}
        >
          ✕
        </button>
      </div>

      <div className="body" data-layout={bodyLayout} style={{ position: 'relative' }}>
        {(layout === 'horizontal' || layout === 'vertical' || layout === 'single') && (
          <aside className="sidebar" data-collapsed={layout === 'single' && !sidebarOpen}>
            <div className="sidebar-head">
              <span>笔记</span>
              <span style={{ marginLeft: 'auto', fontSize: 11 }}>{tree ? countNotes(tree) : 0}</span>
              {layout === 'single' && (
                <button
                  className="icon-btn"
                  style={{ width: 22, height: 22 }}
                  title={sidebarOpen ? '收起列表' : '展开列表'}
                  aria-expanded={sidebarOpen}
                  onClick={() => setSidebarOpen((v) => !v)}
                >
                  {sidebarOpen ? '▴' : '▾'}
                </button>
              )}
            </div>
            {tagFilter && (
              <div style={{ padding: '0 8px 6px' }}>
                <button className="tag-chip" data-active="true" onClick={() => setTagFilter(null)}>
                  {'#' + tagFilter + (tagPaths ? ' · ' + tagPaths.size + ' 篇' : '') + ' ×'}
                </button>
              </div>
            )}
            <div className="sidebar-scroll">
              {tree && (
                <TreeView
                  node={tree}
                  selected={current?.relPath ?? null}
                  tagFilter={tagFilter}
                  allowedPaths={tagPaths}
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
              {/* 单栏模式：必须给编辑/预览切换入口，否则默认 480px 下编辑器会被隐藏 */}
              {layout === 'single' && (
                <div className="mode-tabs">
                  <button
                    className="mode-tab"
                    data-active={!showPreview}
                    onClick={() => setShowPreview(false)}
                  >
                    编辑
                  </button>
                  <button
                    className="mode-tab"
                    data-active={showPreview}
                    onClick={() => setShowPreview(true)}
                  >
                    预览
                  </button>
                  <span className="mode-hint">Ctrl+E 切换</span>
                </div>
              )}
              <div className="panes">
                <div
                  className="editor-pane"
                  data-hidden={layout === 'single' && showPreview}
                  style={layout !== 'single' ? { flexBasis: `${splitRatio * 100}%` } : undefined}
                >
                  <div className="cm-host" ref={hostRef} />
                </div>
                {showPreview && layout !== 'single' && (
                  <div
                    className="splitter"
                    role="separator"
                    aria-orientation={layout === 'horizontal' ? 'vertical' : 'horizontal'}
                    aria-label="拖动调整编辑与预览比例"
                    onMouseDown={onSplitterDown}
                    title="拖动调整比例，双击复位"
                    onDoubleClick={resetSplit}
                  />
                )}
                {showPreview && (
                  <div
                    className="preview-pane"
                    data-hidden={false}
                    style={layout !== 'single' ? { flexBasis: `${(1 - splitRatio) * 100}%` } : undefined}
                  >
                    <div className="md" dangerouslySetInnerHTML={{ __html: previewHtml }} />
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="empty">
              {recentList.length > 0 ? (
                <>
                  <h2>继续上次</h2>
                  <p>接着上次没写完的那篇，或新建一篇。</p>
                  <div className="recent-list">
                    {recentList.slice(0, 5).map((r, i) => (
                      <button
                        key={r.path}
                        className={"recent-item" + (i === 0 ? " primary" : "")}
                        onClick={() => void openItem(r.path)}
                        title={r.path}
                      >
                        <span className="recent-name">{prettyName(r.path)}</span>
                        <span className="recent-time">{prettyTime(r.openedAt)}</span>
                      </button>
                    ))}
                  </div>
                  <div className="empty-actions">
                    <button className="btn" onClick={() => void newNote()}>
                      ＋ 新建笔记
                    </button>
                    <span className="empty-hint">或按 Ctrl+N</span>
                  </div>
                </>
              ) : (
                <>
                  <h2>写下第一条</h2>
                  <p>
                    笔记会存成普通 .md 文件，放在你自己的目录里，随时能用别的编辑器打开。
                  </p>
                  <button className="btn" onClick={() => void newNote()}>
                    ＋ 新建笔记
                  </button>
                  <span className="empty-hint">或按 Ctrl+Alt+N 快速捕捉</span>
                </>
              )}
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

      {dialog && (
        <InlineDialog
          mode={dialog.mode}
          options={dialog.options}
          onResolve={(v) => {
            if (dialog.mode === 'confirm') dialog.resolve(v === true)
            else dialog.resolve(typeof v === 'string' ? v : null)
          }}
        />
      )}

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

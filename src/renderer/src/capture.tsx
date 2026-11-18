/**
 * 快速捕捉窗 —— 零摩擦录入。
 *
 * 设计依据（docs/05-交互重构设计.md §3）：
 *  - 唤起即输入：光标默认在正文，不需要点任何地方
 *  - 文件名框预填时间戳，不改就用时间戳，改了用你的名字（用户拍板 D16）
 *  - 标题与正文分两框，标题可空（用户拍板 D17）
 *  - Enter 只换行，Ctrl+Enter 保存并关闭，Esc 保留内容关闭
 *  - 全程隐式保存：停止输入 600ms 落盘，不弹任何「未保存」提示
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import './capture.css'

/** 时间戳文件名：YYYY-MM-DD-HHmm */
function stampName(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

function Capture(): React.JSX.Element {
  const [name, setName] = useState(stampName())
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const [noteRoot, setNoteRoot] = useState('')
  const [onboardingDone, setOnboardingDone] = useState(true)
  /** 当前已落盘的文件相对路径；改名后随之更新 */
  const relPathRef = useRef<string | null>(null)
  const bodyRef = useRef('')
  const titleRef = useRef('')
  const nameRef = useRef(name)
  const saveTimer = useRef<number | null>(null)
  const bodyEl = useRef<HTMLTextAreaElement | null>(null)
  const nameEl = useRef<HTMLInputElement | null>(null)
  const titleEl = useRef<HTMLInputElement | null>(null)

  bodyRef.current = body
  titleRef.current = title
  nameRef.current = name

  /* ---- 聚焦正文：这是「零摩擦」的核心，挂载后立刻把光标放进正文 ---- */
  const focusBody = useCallback((toEnd = true): void => {
    const el = bodyEl.current
    if (!el) return
    el.focus()
    if (toEnd) {
      const len = el.value.length
      el.setSelectionRange(len, len)
    }
  }, [])

  useEffect(() => {
    void (async () => {
      const c = await window.qn.config.get()
      if (c.ok) {
        setNoteRoot(c.data.noteRoot)
        setOnboardingDone(c.data.onboardingDone)
      }
      // 唤起时若上次有未落盘草稿，恢复它（Drafts「关窗不丢文本」）
      const draft = await window.qn.capture.pending()
      if (draft.ok && draft.data) {
        setName(draft.data.name)
        setTitle(draft.data.title)
        setBody(draft.data.body)
      }
      // 双 rAF 确保布局完成后再聚焦，避免聚焦被首帧覆盖
      requestAnimationFrame(() => requestAnimationFrame(() => focusBody()))
    })()
  }, [focusBody])

  /* ---- 组装最终 Markdown：标题非空则写成 H1 放在正文前 ---- */
  const composeMarkdown = useCallback((): string => {
    const t = titleRef.current.trim()
    const b = bodyRef.current.replace(/\s+$/, '')
    if (t && b) return `# ${t}\n\n${b}`
    if (t) return `# ${t}\n`
    return b
  }, [])

  /* ---- 真正落盘 ---- */
  const flush = useCallback(async (): Promise<boolean> => {
    const md = composeMarkdown()
    if (!md.trim()) {
      // 空内容不建文件，避免产生一堆空笔记
      return true
    }
    setSaveState('saving')
    const r = await window.qn.capture.save({
      relPath: relPathRef.current,
      desiredName: nameRef.current,
      markdown: md
    })
    if (r.ok) {
      relPathRef.current = r.data.relPath
      setSaveState('saved')
      setErrorMsg('')
      return true
    }
    setSaveState('error')
    setErrorMsg(r.error.message)
    return false
  }, [composeMarkdown])

  /* ---- 输入：隐式保存（600ms） ---- */
  const scheduleSave = useCallback(() => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      void flush()
    }, 600)
  }, [flush])

  const onBodyChange = (v: string): void => {
    setBody(v)
    setSaveState('saving')
    scheduleSave()
  }
  const onTitleChange = (v: string): void => {
    setTitle(v)
    setSaveState('saving')
    scheduleSave()
  }

  /* ---- 文件名改动：失焦时改名落盘 ---- */
  const onNameCommit = useCallback(async () => {
    if (!relPathRef.current) {
      // 还没落盘过，等正文有内容时会用这个新名字
      return
    }
    const want = nameRef.current.trim()
    if (!want) return
    const r = await window.qn.capture.rename(relPathRef.current, want)
    if (r.ok) {
      relPathRef.current = r.data.relPath
      setErrorMsg('')
      // 改名后同步显示实际文件名（可能加了 -2）
      const base = r.data.relPath.replace(/\.md$/i, '').split('/').pop() ?? want
      setName(base)
    } else {
      setErrorMsg(r.error.message)
    }
  }, [])

  /* ---- 关闭：先 flush 再通知主进程 ---- */
  const closeWithFlush = useCallback(
    async (keepDraft: boolean): Promise<void> => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
      await flush()
      await onNameCommit()
      await window.qn.capture.close({ keepDraft: keepDraft && !relPathRef.current })
    },
    [flush, onNameCommit]
  )

  /* ---- 键位（§3.3 硬约束） ---- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Ctrl+Enter：保存并关闭（Drafts ⌘↩）
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault()
        void closeWithFlush(false)
        return
      }
      // Esc：保留内容关闭（关窗不丢文本）
      if (e.key === 'Escape') {
        e.preventDefault()
        void closeWithFlush(true)
        return
      }
      // Alt+T：跳到文件名框（本产品特有）
      if (e.altKey && (e.key === 't' || e.key === 'T')) {
        e.preventDefault()
        nameEl.current?.focus()
        nameEl.current?.select()
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeWithFlush])

  /* ---- 窗口失焦：隐式保存，但**不关闭**（用户可能只是切去查资料） ---- */
  useEffect(() => {
    const onBlur = (): void => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
      void flush()
    }
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [flush])

  /* ---- 标题框回车：跳到正文 ---- */
  const onTitleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      focusBody()
    }
  }

  /* ---- 文件名框回车：跳到正文 ---- */
  const onNameKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void onNameCommit().then(() => titleEl.current?.focus())
    }
  }

  const wordCount = body.trim() ? body.trim().replace(/\s/g, '').length : 0
  const dirty = saveState === 'saving'

  return (
    <div className="cap">
      {/* 顶部：文件名。预填时间戳，不改就用它 */}
      <div className="cap-name-row">
        <span className="cap-label" title="Alt+T 可快速跳到此处">
          文件名
        </span>
        <input
          ref={nameEl}
          className="cap-name"
          value={name}
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => void onNameCommit()}
          onKeyDown={onNameKeyDown}
          aria-label="文件名"
        />
        <span className="cap-ext">.md</span>
        <span className="cap-hint">Alt+T</span>
      </div>

      {/* 未完成引导时给一条可点提示，但不阻断写作 */}
      {!onboardingDone && (
        <div className="cap-onboard">
          笔记存在 <code>{noteRoot || '默认目录'}</code>
          <button
            className="cap-link"
            onClick={async () => {
              const r = await window.qn.root.choose()
              if (r.ok && r.data) {
                const s = await window.qn.root.set(r.data)
                if (s.ok) {
                  setNoteRoot(r.data)
                  setOnboardingDone(true)
                }
              }
            }}
          >
            换个目录
          </button>
        </div>
      )}

      {/* 标题（可空） */}
      <input
        ref={titleEl}
        className="cap-title"
        placeholder="标题（可留空）"
        value={title}
        onChange={(e) => onTitleChange(e.target.value)}
        onKeyDown={onTitleKeyDown}
        aria-label="标题"
      />

      {/* 正文：默认焦点在这里 */}
      <textarea
        ref={bodyEl}
        className="cap-body"
        placeholder="想到什么就写什么…  Ctrl+Enter 保存并关闭"
        value={body}
        onChange={(e) => onBodyChange(e.target.value)}
        aria-label="正文"
      />

      <div className="cap-foot">
        <span className={'cap-state' + (saveState === 'error' ? ' err' : '')}>
          {saveState === 'error'
            ? `保存失败：${errorMsg}`
            : dirty
              ? '正在保存…'
              : saveState === 'saved'
                ? '已保存'
                : '自动保存'}
        </span>
        <span className="cap-count">{wordCount} 字</span>
        <span className="cap-grow" />
        <button className="cap-btn ghost" onClick={() => void closeWithFlush(true)}>
          Esc 保留
        </button>
        <button className="cap-btn" onClick={() => void closeWithFlush(false)}>
          Ctrl+Enter 完成
        </button>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Capture />)

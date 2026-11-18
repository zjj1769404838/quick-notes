/**
 * CodeMirror 6 编辑器封装 —— 承接 FR-4 的格式智能提示全部能力。
 *
 * FR-4.1 列表自动续写  → markdownKeymap (insertNewlineContinueMarkupCommand)
 * FR-4.2 缩进            → indentWithTab + 自定义 2 空格
 * FR-4.3 代码块补全      → 自定义 Enter handler
 * FR-4.4 符号配对        → closeBrackets
 * FR-4.5/4.6 斜杠命令    → autocompletion({ override: [slashSource] })
 * FR-4.7 表格 Tab 跳格   → 自定义 keymap
 * FR-4.8 结构提示        → linter（标题跳级 / 未闭合代码块 / 空链接）
 * FR-4.9 快捷键          → Ctrl+B/I/K/Shift+K
 * FR-4.10 粘贴图片       → paste handler（由上层注入保存回调）
 */
import { useCallback, useEffect, useRef } from 'react'
import { EditorState, StateEffect, StateField, type Extension } from '@codemirror/state'
import {
  EditorView,
  keymap,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  lineNumbers,
  placeholder as cmPlaceholder
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import {
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  syntaxHighlighting,
  syntaxTree
} from '@codemirror/language'
import { markdown, markdownLanguage, markdownKeymap } from '@codemirror/lang-markdown'
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  type CompletionContext,
  type CompletionResult
} from '@codemirror/autocomplete'
import { linter, lintGutter, type Diagnostic } from '@codemirror/lint'
import { searchKeymap } from '@codemirror/search'

export interface EditorApi {
  getValue: () => string
  setValue: (v: string) => void
  focus: () => void
  getCursor: () => { line: number; col: number }
  insertText: (text: string) => void
  replaceSelection: (text: string) => void
  getSelection: () => string
  scrollToLine: (lineNo: number) => void
  indentOrOutdent: (outdent: boolean) => void
}

export interface EditorProps {
  initialValue: string
  onChange: (value: string) => void
  onCursor?: (line: number, col: number) => void
  onSave?: () => void
  onPasteImage?: () => Promise<string | null>
  /** 由外部触发重新定位到某行（大纲点击） */
  gotoLine?: { line: number; nonce: number } | null
  readOnly?: boolean
  /** 变化时重建编辑器（用于「笔记就绪后才渲染 cm-host」的挂载时机） */
  mountKey?: string | null
}

/* ============ 斜杠命令（FR-4.5 / 4.6） ============ */

interface SlashCmd {
  label: string
  detail: string
  insert: string
  /** 插入后光标相对插入点末尾的回退字符数 */
  cursorBack?: number
}

const SLASH_COMMANDS: SlashCmd[] = [
  { label: '/h1', detail: '一级标题', insert: '# ' },
  { label: '/h2', detail: '二级标题', insert: '## ' },
  { label: '/h3', detail: '三级标题', insert: '### ' },
  { label: '/todo', detail: '待办清单', insert: '- [ ] ' },
  { label: '/list', detail: '无序列表', insert: '- ' },
  { label: '/num', detail: '有序列表', insert: '1. ' },
  { label: '/table', detail: '表格', insert: '| 列 1 | 列 2 |\n| --- | --- |\n|  |  |' },
  { label: '/code', detail: '代码块', insert: '```\n\n```', cursorBack: 4 },
  { label: '/quote', detail: '引用', insert: '> ' },
  { label: '/divider', detail: '分割线', insert: '---\n' },
  { label: '/link', detail: '链接', insert: '[文字](https://)' },
  { label: '/image', detail: '图片', insert: '![](assets/)' },
  { label: '/date', detail: '当前日期', insert: new Date().toISOString().slice(0, 10) },
  { label: '/time', detail: '当前时间', insert: new Date().toTimeString().slice(0, 5) }
]

/** 只在行首或空格后触发；代码块内不触发 */
function slashSource(context: CompletionContext): CompletionResult | null {
  const before = context.matchBefore(/\/[\p{L}\p{N}]*/u)
  if (!before) return null
  // 前面必须是行首或空白
  const charBefore = before.from > 0 ? context.state.doc.sliceString(before.from - 1, before.from) : ''
  if (charBefore && !/\s/.test(charBefore)) return null
  // 代码围栏内不触发
  const line = context.state.doc.lineAt(before.from)
  const textBeforeLine = context.state.doc.sliceString(0, line.from)
  const fenceCount = (textBeforeLine.match(/^```/gm) ?? []).length
  if (fenceCount % 2 === 1) return null

  return {
    from: before.from,
    options: SLASH_COMMANDS.map((c) => ({
      label: c.label,
      detail: c.detail,
      type: 'keyword',
      apply: (view: EditorView) => {
        const pos = view.state.selection.main.head
        view.dispatch({
          changes: { from: before.from, to: pos, insert: c.insert },
          selection: { anchor: before.from + c.insert.length - (c.cursorBack ?? 0) }
        })
      }
    })),
    validFor: /^\/[\p{L}\p{N}]*$/u
  }
}

/* ============ 表格 Tab 跳格（FR-4.7） ============ */

function isInTableLine(state: EditorState, pos: number): boolean {
  const line = state.doc.lineAt(pos)
  if (!line.text.trimStart().startsWith('|')) return false
  let node = syntaxTree(state).resolveInner(pos, -1)
  while (node) {
    if (node.name === 'Table') return true
    node = node.parent as typeof node
  }
  // 回退：本行以 | 开头且有至少两个 | 也视为表格
  return (line.text.match(/\|/g) ?? []).length >= 2
}

function tableTabKey(outdent: boolean) {
  return {
    key: 'Tab',
    shift: outdent,
    run: (view: EditorView): boolean => {
      const state = view.state
      const pos = state.selection.main.head
      if (!isInTableLine(state, pos)) return false
      const line = state.doc.lineAt(pos)
      const text = line.text
      // 找下一个 | 之后的单元格起点
      if (!outdent) {
        const nextBar = text.indexOf('|', pos - line.from + 1)
        if (nextBar === -1) {
          // 行尾 → 补一个单元格
          view.dispatch({
            changes: { from: line.to, insert: '  |' },
            selection: { anchor: line.to + 3 }
          })
          return true
        }
        // 跳过紧随的空白
        let anchor = line.from + nextBar + 1
        while (anchor < line.to && text[anchor - line.from] === ' ') anchor++
        view.dispatch({ selection: { anchor } })
        return true
      }
      // Shift+Tab：找前一个 | 之后的单元格起点
      const start = pos - line.from - 1
      const prevBar = text.lastIndexOf('|', start)
      if (prevBar === -1) return false
      let anchor = line.from + prevBar + 1
      while (anchor < line.to && text[anchor - line.from] === ' ') anchor++
      view.dispatch({ selection: { anchor } })
      return true
    }
  }
}

/* ============ 代码块自动补全（FR-4.3） ============ */

const codeFenceEnter = {
  key: 'Enter',
  run: (view: EditorView): boolean => {
    const state = view.state
    const sel = state.selection.main
    if (!sel.empty) return false
    const line = state.doc.lineAt(sel.head)
    const text = line.text
    // 光标前刚好是三个反引号（或带语言的围栏）
    const m = /^(\s*)(```|~~~)([\w+-]*)\s*$/.exec(text)
    if (!m) return false
    const fence = m[2]
    const insert = `\n\n${m[1]}${fence}`
    view.dispatch({
      changes: { from: line.to, insert },
      selection: { anchor: line.to + 1 }
    })
    return true
  }
}

/* ============ 结构提示 linter（FR-4.8） ============ */

const structureLinter = linter(
  (view): Diagnostic[] => {
    const diags: Diagnostic[] = []
    const doc = view.state.doc
    const text = doc.toString()
    const lines = text.split('\n')

    // 1) 标题跳级：#### 后接 ##
    let lastLevel = 0
    let offset = 0
    const levelStarts: Array<{ level: number; from: number; to: number }> = []
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]
      const m = /^(#{1,6})\s+\S/.exec(l)
      if (m) {
        const level = m[1].length
        levelStarts.push({ level, from: offset, to: offset + m[0].length })
      }
      offset += l.length + 1
    }
    for (let i = 1; i < levelStarts.length; i++) {
      const prev = levelStarts[i - 1]
      const cur = levelStarts[i]
      if (cur.level - prev.level > 1) {
        diags.push({
          from: cur.from,
          to: cur.to,
          severity: 'info',
          message: `标题层级跳级（从 H${prev.level} 跳到 H${cur.level}），建议逐级递进`
        })
      }
      lastLevel = cur.level
    }
    void lastLevel

    // 2) 未闭合代码围栏
    const fences = [...text.matchAll(/^(```|~~~)/gm)]
    if (fences.length % 2 === 1) {
      const last = fences[fences.length - 1]
      const at = last.index ?? 0
      diags.push({ from: at, to: at + 3, severity: 'warning', message: '代码块没有闭合，缺少结束的 ```' })
    }

    // 3) 空链接 [](...) 或标为空 href
    for (const m of text.matchAll(/\[\s*\]\(\s*([^)\s]*)\s*\)/g)) {
      const at = m.index ?? 0
      diags.push({ from: at, to: at + m[0].length, severity: 'warning', message: '链接文字为空' })
    }
    for (const m of text.matchAll(/\[[^\]]+\]\(\s*\)/g)) {
      const at = m.index ?? 0
      diags.push({ from: at, to: at + m[0].length, severity: 'warning', message: '链接地址为空' })
    }

    return diags
  },
  { delay: 400 }
)

/* ============ 快捷键（FR-4.9） ============ */

function wrapSelection(view: EditorView, marker: string): boolean {
  const { from, to } = view.state.selection.main
  const doc = view.state.doc
  const selected = doc.sliceString(from, to)
  if (from === to) {
    // 无选区：插入成对标记并把光标放中间
    view.dispatch({
      changes: { from, to, insert: `${marker}${marker}` },
      selection: { anchor: from + marker.length }
    })
    return true
  }
  // 已有包裹 → 去掉
  const before = doc.sliceString(Math.max(0, from - marker.length), from)
  const after = doc.sliceString(to, Math.min(doc.length, to + marker.length))
  if (before === marker && after === marker) {
    view.dispatch({
      changes: [
        { from: from - marker.length, to: from, insert: '' },
        { from: to, to: to + marker.length, insert: '' }
      ],
      selection: { anchor: from - marker.length }
    })
    return true
  }
  view.dispatch({
    changes: { from, to, insert: `${marker}${selected}${marker}` },
    selection: { anchor: from + marker.length, head: to + marker.length }
  })
  return true
}

const shortcutKeymap: Extension = keymap.of([
  {
    key: 'Mod-b',
    run: (v) => wrapSelection(v, '**')
  },
  {
    key: 'Mod-i',
    run: (v) => wrapSelection(v, '_')
  },
  {
    key: 'Mod-Shift-k',
    run: (v) => wrapSelection(v, '`')
  },
  {
    key: 'Mod-k',
    run: (v) => {
      const { from, to } = v.state.selection.main
      const selected = v.state.doc.sliceString(from, to)
      const insert = selected ? `[${selected}](https://)` : '[文字](https://)'
      const selStart = selected ? from + selected.length + 3 : from + 1
      const selEnd = selected ? from + selected.length + 12 : from + 6
      v.dispatch({
        changes: { from, to, insert },
        selection: { anchor: selStart, head: selEnd }
      })
      return true
    }
  }
])

/* CodeMirror 相关引用保留（供后续大纲高亮扩展使用） */
void StateEffect
void StateField
void drawSelection
void highlightActiveLineGutter
void searchKeymap

export function useCodeMirror({ initialValue, onChange, onCursor, onSave, onPasteImage, gotoLine, readOnly, mountKey }: EditorProps): {
  hostRef: React.RefObject<HTMLDivElement | null>
  apiRef: React.MutableRefObject<EditorApi | null>
} {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const apiRef = useRef<EditorApi | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const onCursorRef = useRef(onCursor)
  const onSaveRef = useRef(onSave)
  const onPasteRef = useRef(onPasteImage)

  onChangeRef.current = onChange
  onCursorRef.current = onCursor
  onSaveRef.current = onSave
  onPasteRef.current = onPasteImage

  const buildExtensions = useCallback((): Extension[] => {
    return [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      drawSelection(),
      history(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      autocompletion({ override: [slashSource], activateOnTyping: true, maxRenderedOptions: 10 }),
      markdown({ base: markdownLanguage, addKeymap: false }),
      // FR-4.1 列表自动续写：必须显式装上 markdownKeymap，
      // 否则 markdown() 的 addKeymap:false 会让回车续写/空项退出列表全部失效。
      keymap.of(markdownKeymap),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      lintGutter(),
      structureLinter,
      cmPlaceholder('在这里开始记笔记…  输入 / 打开命令菜单'),
      EditorView.lineWrapping,
      EditorState.readOnly.of(!!readOnly),
      keymap.of([
        // 先放自定义，保证优先级高于默认
        codeFenceEnter,
        tableTabKey(false),
        tableTabKey(true)
      ]),
      shortcutKeymap,
      keymap.of([
        {
          key: 'Mod-s',
          run: (): boolean => {
            onSaveRef.current?.()
            return true
          }
        },
        {
          key: 'Enter',
          run: (view): boolean => {
            // 列表续写：交由 markdownKeymap 处理（这里只兜底回车不拦截）
            void view
            return false
          }
        },
        ...closeBracketsKeymap,
        ...completionKeymap,
        ...historyKeymap,
        ...defaultKeymap,
        indentWithTab
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) {
          onChangeRef.current(u.state.doc.toString())
        }
        if (u.selectionSet || u.docChanged) {
          const head = u.state.selection.main.head
          const line = u.state.doc.lineAt(head)
          onCursorRef.current?.(line.number, head - line.from + 1)
        }
      }),
      EditorView.domEventHandlers({
        paste: (event, view) => {
          const items = event.clipboardData?.items
          if (!items) return false
          for (const it of items) {
            if (it.type.startsWith('image/')) {
              event.preventDefault()
              void (async () => {
                const link = await onPasteRef.current?.()
                if (link) {
                  const pos = view.state.selection.main.head
                  view.dispatch({
                    changes: { from: pos, insert: `![](${link})` },
                    selection: { anchor: pos + 4 + link.length - 1 }
                  })
                }
              })()
              return true
            }
          }
          return false
        }
      })
    ]
  }, [readOnly])

  useEffect(() => {
    if (!hostRef.current) return
    const state = EditorState.create({ doc: initialValue, extensions: buildExtensions() })
    const view = new EditorView({ state, parent: hostRef.current })
    viewRef.current = view
    apiRef.current = {
      getValue: () => view.state.doc.toString(),
      setValue: (v: string) => {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } })
      },
      focus: () => view.focus(),
      getCursor: () => {
        const head = view.state.selection.main.head
        const line = view.state.doc.lineAt(head)
        return { line: line.number, col: head - line.from + 1 }
      },
      insertText: (text: string) => {
        const pos = view.state.selection.main.head
        view.dispatch({ changes: { from: pos, insert: text }, selection: { anchor: pos + text.length } })
      },
      replaceSelection: (text: string) => {
        const { from, to } = view.state.selection.main
        view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } })
      },
      getSelection: () => {
        const { from, to } = view.state.selection.main
        return view.state.doc.sliceString(from, to)
      },
      scrollToLine: (lineNo: number) => {
        const clamped = Math.max(1, Math.min(lineNo, view.state.doc.lines))
        const line = view.state.doc.line(clamped)
        view.dispatch({
          selection: { anchor: line.from },
          effects: EditorView.scrollIntoView(line.from, { y: 'center' })
        })
        view.focus()
      },
      indentOrOutdent: (outdent: boolean) => {
        const { from, to } = view.state.selection.main
        const startLine = view.state.doc.lineAt(from).number
        const endLine = view.state.doc.lineAt(to).number
        const changes: Array<{ from: number; to: number; insert: string }> = []
        for (let n = startLine; n <= endLine; n++) {
          const line = view.state.doc.line(n)
          if (outdent) {
            const strip = line.text.startsWith('  ') ? 2 : line.text.startsWith(' ') ? 1 : 0
            if (strip) changes.push({ from: line.from, to: line.from + strip, insert: '' })
          } else {
            changes.push({ from: line.from, to: line.from, insert: '  ' })
          }
        }
        if (changes.length) view.dispatch({ changes })
      }
    }
    return () => {
      view.destroy()
      viewRef.current = null
      apiRef.current = null
    }
    // 依赖 mountKey：cm-host 只在有 current 笔记时渲染，
    // 若只在首次挂载运行，hostRef 当时为 null 就永远不会创建编辑器。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mountKey])

  // 外部跳转（大纲点击）
  useEffect(() => {
    if (gotoLine && apiRef.current) {
      apiRef.current.scrollToLine(gotoLine.line)
    }
  }, [gotoLine])

  return { hostRef, apiRef }
}

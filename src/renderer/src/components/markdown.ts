/** Markdown 渲染 —— markdown-it + DOMPurify，按 FR-3.2 自适应防抖 */
import MarkdownItCallable, {
  type MarkdownIt,
  type Renderer,
  type Token,
  type MarkdownItOptions,
  type Env
} from 'markdown-it'
import DOMPurify from 'dompurify'
import footnote from 'markdown-it-footnote'

let md: MarkdownIt | null = null

function engine(): MarkdownIt {
  if (md) return md
  const opts: MarkdownItOptions = {
    html: false, // 禁原始 HTML，避免注入面
    linkify: true,
    breaks: true,
    typographer: false
  }
  const inst = new MarkdownItCallable(opts)
  inst.use(footnote)
  // 让外部链接在新窗口打开
  const renderer: Renderer = inst.renderer
  const defaultRender =
    renderer.rules.link_open ??
    ((tokens: Token[], idx: number, options: Required<MarkdownItOptions>, _env: Env | undefined, self: Renderer): string =>
      self.renderToken(tokens, idx, options))
  renderer.rules.link_open = (
    tokens: Token[],
    idx: number,
    options: Required<MarkdownItOptions>,
    env: Env | undefined,
    self: Renderer
  ): string => {
    if (tokens[idx].attrGet('target') === null) tokens[idx].attrSet('target', '_blank')
    tokens[idx].attrSet('rel', 'noreferrer noopener')
    return defaultRender(tokens, idx, options, env, self)
  }
  md = inst
  return md
}

/** 任务列表：把 - [ ] / - [x] 渲染成复选框样式（只读展示） */
function enhanceTaskLists(html: string): string {
  return html.replace(
    /<li>\s*\[([ xX])\]\s*/g,
    (_m, mark: string) => `<li class="task"><input type="checkbox" disabled ${mark !== ' ' ? 'checked' : ''} /> `
  )
}

export function renderMarkdown(src: string): string {
  const raw = engine().render(src)
  const withTasks = enhanceTaskLists(raw)
  // XSS 净化：粘贴/导入的 md 都是不可信输入
  return DOMPurify.sanitize(withTasks, {
    ALLOWED_URI_REGEXP: /^(?:https?:|assets\/|data:image\/|mailto:)/i,
    ADD_ATTR: ['target', 'rel', 'disabled', 'checked', 'type']
  })
}

/** 从 Markdown 提取大纲（标题层级 + 源码行号） */
export interface OutlineItem {
  level: number
  text: string
  line: number
}

export function extractOutline(src: string): OutlineItem[] {
  const out: OutlineItem[] = []
  const lines = src.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (/^\s*(```|~~~)/.test(l)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l)
    if (m) out.push({ level: m[1].length, text: m[2].trim(), line: i + 1 })
  }
  return out
}

/** 统计字数：中文按字计，英文按词计 */
export function countWords(src: string): { chars: number; words: number } {
  const chars = src.length
  const cjk = (src.match(/[\u4e00-\u9fff]/g) ?? []).length
  const latinWords = (src.match(/[A-Za-z][A-Za-z'-]*/g) ?? []).length
  return { chars, words: cjk + latinWords }
}

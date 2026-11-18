/**
 * 笔记服务 —— 笔记文件的读写、目录树、回收站、frontmatter 与标签解析。
 * 事实源是磁盘上的 .md 文件；本模块不持有正文状态的唯一副本。
 * 规范见 04-数据模型文档.md §2/§3/§4/§9。
 */
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import type { DirNode, NoteContent, NoteMeta } from '../../shared/types.js'
import { ErrorCode } from '../../shared/types.js'

const TRASH_DIR = '.trash'
const ASSETS_DIR = 'assets'
const IGNORED_DIRS = new Set([TRASH_DIR, ASSETS_DIR, 'node_modules', '.git', '.obsidian'])
/** Windows 非法字符 + 保留设备名 */
const ILLEGAL_CHARS = /[<>:"|?*\u0000-\u001f]/
const RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
])

export interface FrontmatterSplit {
  frontmatter: Record<string, unknown> | null
  body: string
  /** 原始 frontmatter 文本（含 --- 包裹），用于原样保留自定义字段 */
  rawFrontmatter: string | null
}

/** 切分 frontmatter —— 失败时降级为「当正文处理」，不报错不改写（04 §3） */
export function splitFrontmatter(text: string): FrontmatterSplit {
  if (!text.startsWith('---')) return { frontmatter: null, body: text, rawFrontmatter: null }
  // 必须首行是 --- 且能找到下一行独立的 ---
  const firstNl = text.indexOf('\n')
  if (firstNl === -1) return { frontmatter: null, body: text, rawFrontmatter: null }
  const head = text.slice(0, firstNl).trimEnd()
  if (head !== '---') return { frontmatter: null, body: text, rawFrontmatter: null }

  const rest = text.slice(firstNl + 1)
  const lines = rest.split('\n')
  let closeIdx = -1
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trimEnd()
    if (l === '---' || l === '...') {
      closeIdx = i
      break
    }
  }
  if (closeIdx === -1) return { frontmatter: null, body: text, rawFrontmatter: null }

  const fmText = lines.slice(0, closeIdx).join('\n')
  const body = lines.slice(closeIdx + 1).join('\n')
  try {
    const parsed = yaml.load(fmText)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        frontmatter: parsed as Record<string, unknown>,
        body,
        rawFrontmatter: text.slice(0, firstNl + 1) + fmText + '\n---\n'
      }
    }
    return { frontmatter: null, body: text, rawFrontmatter: null }
  } catch {
    // YAML 解析失败 → 当正文（不丢用户内容）
    return { frontmatter: null, body: text, rawFrontmatter: null }
  }
}

/** 剥离围栏代码块与行内代码，避免其中的 # 被当作标签（04 §4） */
export function stripCode(text: string): string {
  // 围栏代码块：``` 或 ~~~ 到匹配的结束围栏
  let out = text.replace(/^([ \t]*)(```+|~~~+)[^\n]*\n[\s\S]*?(?:\n\1\2[ \t]*$|$)/gm, '\n')
  // 行内代码：`...`（不跨行）
  out = out.replace(/`[^`\n]*`/g, ' ')
  return out
}

/** 行内标签：Unicode 属性类，支持中文与 / 分层；URL 中的 # 不匹配（04 §4） */
const INLINE_TAG_RE = /(^|[\s(（[【,，。；;:：])#([\p{L}\p{N}_/-]{1,64})/gu
const URL_HASH_RE = /\bhttps?:\/\/\S+#\S*/gu

export function extractInlineTags(body: string): string[] {
  const cleaned = stripCode(body).replace(URL_HASH_RE, ' ')
  const tags = new Set<string>()
  for (const m of cleaned.matchAll(INLINE_TAG_RE)) {
    const t = normalizeTag(m[2])
    if (t) tags.add(t)
  }
  return [...tags]
}

/** 标签归一化：NFC + 小写 + 去首尾 / 与连续 / */
export function normalizeTag(raw: string): string {
  let t = raw.normalize('NFC').trim().toLowerCase()
  t = t.replace(/^\/+|\/+$/g, '')
  t = t.replace(/\/{2,}/g, '/')
  return t
}

export function extractFrontmatterTags(fm: Record<string, unknown> | null): string[] {
  if (!fm) return []
  const raw = fm.tags ?? fm.tag
  const list: string[] = []
  if (typeof raw === 'string') {
    list.push(...raw.split(/[,，\s]+/))
  } else if (Array.isArray(raw)) {
    for (const v of raw) if (typeof v === 'string') list.push(v)
  }
  return list.map(normalizeTag).filter(Boolean)
}

/** 从正文提取标题：首个 ATX 一级/任意级标题，否则首行非空文本，否则文件名 */
export function extractTitle(body: string, fallback: string): string {
  for (const line of body.split('\n')) {
    const m = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)
    if (m) return m[1].trim()
  }
  for (const line of body.split('\n')) {
    const t = line.trim()
    if (t && !t.startsWith('![')) return t.slice(0, 120)
  }
  return fallback
}

export function detectEol(raw: string): 'lf' | 'crlf' {
  return raw.includes('\r\n') ? 'crlf' : 'lf'
}

export function isValidNoteName(name: string): { ok: true } | { ok: false; reason: string } {
  if (!name || !name.trim()) return { ok: false, reason: '名称不能为空' }
  if (ILLEGAL_CHARS.test(name)) return { ok: false, reason: '名称包含 Windows 不允许的字符：< > : " | ? *' }
  const base = name.replace(/\.md$/i, '')
  if (RESERVED_NAMES.has(base.toLowerCase())) return { ok: false, reason: `「${base}」是 Windows 保留名，请换一个` }
  if (base.endsWith('.') || base.endsWith(' ')) return { ok: false, reason: '名称不能以句点或空格结尾' }
  if (base.length > 120) return { ok: false, reason: '名称过长（上限 120 字符）' }
  return { ok: true }
}

function ioError(e: unknown, code: string = ErrorCode.E_IO): Error {
  const err = new Error(e instanceof Error ? e.message : String(e)) as Error & { code?: string }
  err.code = code
  return err
}

/** 保证目标路径在笔记根目录内（防目录穿越，FR-5.3） */
export function resolveInRoot(root: string, relPath: string): string {
  const abs = path.resolve(root, relPath)
  const rel = path.relative(root, abs)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    const err = new Error('路径超出笔记目录') as Error & { code?: string }
    err.code = ErrorCode.E_OUTSIDE_ROOT
    throw err
  }
  return abs
}

export class NoteService {
  private root: string

  constructor(root: string) {
    this.root = path.resolve(root)
  }

  get rootDir(): string {
    return this.root
  }

  async setRoot(root: string): Promise<void> {
    this.root = path.resolve(root)
    await fs.mkdir(this.root, { recursive: true })
  }

  async ensureRoot(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true })
    await fs.mkdir(path.join(this.root, TRASH_DIR), { recursive: true })
  }

  /** 递归列目录树（跳过 .trash / assets / node_modules / 隐藏目录） */
  async listTree(): Promise<DirNode> {
    const walk = async (abs: string, rel: string): Promise<DirNode[]> => {
      let entries: import('node:fs').Dirent[]
      try {
        entries = await fs.readdir(abs, { withFileTypes: true })
      } catch {
        return []
      }
      const dirs: DirNode[] = []
      const files: DirNode[] = []
      for (const e of entries) {
        if (e.name.startsWith('.')) continue
        const childRel = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) {
          if (IGNORED_DIRS.has(e.name.toLowerCase())) continue
          dirs.push({
            name: e.name,
            relPath: childRel,
            type: 'dir',
            children: await walk(path.join(abs, e.name), childRel)
          })
        } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
          let mtimeMs = 0
          try {
            mtimeMs = (await fs.stat(path.join(abs, e.name))).mtimeMs
          } catch {
            /* 忽略 */
          }
          files.push({ name: e.name, relPath: childRel, type: 'file', mtimeMs })
        }
      }
      dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
      files.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0))
      return [...dirs, ...files]
    }

    const children = await walk(this.root, '')
    return { name: path.basename(this.root), relPath: '', type: 'dir', children }
  }

  /** 读取一个笔记的完整内容 */
  async read(relPath: string): Promise<NoteContent> {
    const abs = resolveInRoot(this.root, relPath)
    let raw: string
    try {
      raw = await fs.readFile(abs, 'utf-8')
    } catch (e) {
      const err = ioError(e, ErrorCode.E_NOT_FOUND)
      throw err
    }
    const st = await fs.stat(abs)
    const { frontmatter, body, rawFrontmatter } = splitFrontmatter(raw)
    return {
      relPath,
      body,
      frontmatter,
      rawFrontmatter,
      eol: detectEol(raw),
      mtimeMs: st.mtimeMs
    }
  }

  /** 写入笔记（原子：临时文件 + fsync + rename） */
  async write(relPath: string, body: string, eol: 'lf' | 'crlf' = 'crlf', fmText?: string): Promise<{ mtimeMs: number }> {
    const abs = resolveInRoot(this.root, relPath)
    const normalized = eol === 'crlf' ? body.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n') : body.replace(/\r\n/g, '\n')
    const payload = fmText ? fmText + normalized : normalized
    await fs.mkdir(path.dirname(abs), { recursive: true })
    const tmp = `${abs}.${process.pid}.tmp`
    try {
      const fh = await fs.open(tmp, 'w')
      try {
        await fh.writeFile(payload, 'utf-8')
        await fh.sync()
      } finally {
        await fh.close()
      }
      await fs.rename(tmp, abs)
    } catch (e) {
      await fs.rm(tmp, { force: true }).catch(() => undefined)
      throw ioError(e)
    }
    const st = await fs.stat(abs)
    return { mtimeMs: st.mtimeMs }
  }

  /** 新建笔记，文件名 YYYY-MM-DD-HHmm.md，冲突加 -2、-3… */
  async create(initialBody = ''): Promise<{ relPath: string }> {
    await this.ensureRoot()
    const now = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
    let relPath = `${stamp}.md`
    let n = 2
    while (existsSync(path.join(this.root, relPath))) {
      relPath = `${stamp}-${n}.md`
      n++
      if (n > 999) throw ioError(new Error('同分钟笔记过多'))
    }
    const body = initialBody || `# \n\n`
    await this.write(relPath, body, 'crlf')
    return { relPath }
  }

  /** 重命名（仅同一目录内改名） */
  async rename(relPath: string, newName: string): Promise<{ relPath: string }> {
    const nameNoExt = newName.replace(/\.md$/i, '')
    const check = isValidNoteName(nameNoExt)
    if (!check.ok) {
      const err = new Error(check.reason) as Error & { code?: string }
      err.code = ErrorCode.E_INVALID_PATH
      throw err
    }
    const from = resolveInRoot(this.root, relPath)
    const dir = path.dirname(relPath)
    const toRel = dir && dir !== '.' ? `${dir}/${nameNoExt}.md` : `${nameNoExt}.md`
    const to = resolveInRoot(this.root, toRel)
    if (existsSync(to)) {
      const err = new Error('同名笔记已存在') as Error & { code?: string }
      err.code = ErrorCode.E_CONFLICT
      throw err
    }
    await fs.rename(from, to)
    return { relPath: toRel }
  }

  /** 删除 → 移入 .trash/<YYYYMMDD>/<原相对路径>（保留目录结构，FR-5.5 / 04 §9） */
  async trash(relPath: string): Promise<void> {
    const from = resolveInRoot(this.root, relPath)
    const d = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    const day = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
    const targetRel = path.posix.join(TRASH_DIR, day, relPath)
    const to = resolveInRoot(this.root, targetRel)
    await fs.mkdir(path.dirname(to), { recursive: true })
    // 不覆盖：若已存在则加后缀
    let finalTo = to
    let n = 2
    while (existsSync(finalTo)) {
      finalTo = to.replace(/\.md$/i, `-${n}.md`)
      n++
    }
    try {
      await fs.rename(from, finalTo)
    } catch (e) {
      throw ioError(e)
    }
  }

  /** 保存剪贴板图片到同目录 assets/，返回可插入的相对链接（FR-4.10） */
  async savePastedImage(noteRelPath: string, pngBytes: Buffer): Promise<string> {
    const dir = path.dirname(noteRelPath)
    const d = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
    const assetsRel = dir && dir !== '.' ? `${dir}/${ASSETS_DIR}` : ASSETS_DIR
    const fileName = `${stamp}.png`
    const targetRel = `${assetsRel}/${fileName}`
    const abs = resolveInRoot(this.root, targetRel)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, pngBytes)
    // 相对当前笔记的链接路径（同目录 assets/xxx.png）
    return `${ASSETS_DIR}/${fileName}`
  }

  /** 扫描全部笔记的元信息（供索引与标签面板） */
  async scanAll(): Promise<NoteMeta[]> {
    const out: NoteMeta[] = []
    const walk = async (abs: string, rel: string): Promise<void> => {
      let entries: import('node:fs').Dirent[]
      try {
        entries = await fs.readdir(abs, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue
        const childRel = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) {
          if (IGNORED_DIRS.has(e.name.toLowerCase())) continue
          await walk(path.join(abs, e.name), childRel)
        } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
          try {
            const full = path.join(abs, e.name)
            const st = await fs.stat(full)
            const raw = await fs.readFile(full, 'utf-8')
            const { frontmatter, body } = splitFrontmatter(raw)
            const fallback = e.name.replace(/\.md$/i, '')
            const tags = [...new Set([...extractFrontmatterTags(frontmatter), ...extractInlineTags(body)])]
            out.push({
              relPath: childRel,
              title: (typeof frontmatter?.title === 'string' && frontmatter.title) || extractTitle(body, fallback),
              mtimeMs: st.mtimeMs,
              size: st.size,
              tags
            })
          } catch {
            /* 单个文件失败不影响整体 */
          }
        }
      }
    }
    await walk(this.root, '')
    return out
  }
}

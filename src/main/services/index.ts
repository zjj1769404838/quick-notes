/**
 * 索引服务 —— MiniSearch 全文检索 + 中文分词 + 原子落盘 + mtime/size 增量。
 * 规范见 04-数据模型文档.md §5。
 * 中文分词用 Node 22 内置 Intl.Segmenter（不引入需编译的 nodejieba）。
 */
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import MiniSearch, { type SearchResult as MSSearchResult } from 'minisearch'
import type { NoteMeta, SearchHit } from '../../shared/types.js'

const FORMAT_VERSION = 1
const ENGINE = 'minisearch-7'

interface IndexedDoc {
  id: string
  relPath: string
  title: string
  body: string
  tags: string
  mtimeMs: number
  size: number
}

interface IndexFile {
  formatVersion: number
  engine: string
  tokenizer: string
  rootHash: string
  builtAt: number
  docs: IndexedDoc[]
}

/** 中文 + 英文混排分词：中日韩按字切开，拉丁按词切开，数字整段保留 */
export function tokenize(text: string): string[] {
  if (!text) return []
  const out: string[] = []
  const seg = new Intl.Segmenter('zh-CN', { granularity: 'word' })
  for (const part of seg.segment(text.toLowerCase())) {
    const w = part.segment.trim()
    if (!w) continue
    // 标点与纯空白丢弃
    if (!/[\p{L}\p{N}]/u.test(w)) continue
    // 中文按单字再切一遍，提升召回（中文常见二字词也能命中）
    if (/[\u4e00-\u9fff]/.test(w)) {
      for (const ch of w) {
        if (/[\u4e00-\u9fff]/u.test(ch)) out.push(ch)
      }
    } else {
      out.push(w)
    }
  }
  return out
}

export function rootHashOf(root: string): string {
  return crypto.createHash('sha1').update(path.resolve(root).toLowerCase()).digest('hex').slice(0, 12)
}

export class IndexService {
  private index: MiniSearch<IndexedDoc> | null = null
  private docs = new Map<string, IndexedDoc>()
  private root: string
  private storeDir: string
  private building = false
  private lastBuiltAt = 0

  constructor(root: string, storeDir: string) {
    this.root = path.resolve(root)
    this.storeDir = storeDir
  }

  private get filePath(): string {
    return path.join(this.storeDir, `${rootHashOf(this.root)}-search-index.json`)
  }

  private createIndex(): MiniSearch<IndexedDoc> {
    return new MiniSearch<IndexedDoc>({
      fields: ['title', 'body', 'tags'],
      storeFields: ['relPath', 'title', 'body', 'tags', 'mtimeMs', 'size'],
      tokenize,
      searchOptions: {
        boost: { title: 3, tags: 2, body: 1 },
        fuzzy: 0.2,
        prefix: true,
        combineWith: 'AND'
      }
    })
  }

  /** 切换笔记根目录 —— 只切索引命名空间，不动文件（FR-5.9） */
  async setRoot(root: string): Promise<void> {
    this.root = path.resolve(root)
    this.index = null
    this.docs.clear()
    await this.load()
  }

  get status(): { ready: boolean; docs: number; lastBuiltAt: number; building: boolean } {
    return { ready: !!this.index, docs: this.docs.size, lastBuiltAt: this.lastBuiltAt, building: this.building }
  }

  async load(): Promise<void> {
    try {
      if (!existsSync(this.filePath)) return
      const raw = await fs.readFile(this.filePath, 'utf-8')
      const parsed = JSON.parse(raw) as IndexFile
      if (
        parsed.formatVersion !== FORMAT_VERSION ||
        parsed.engine !== ENGINE ||
        parsed.rootHash !== rootHashOf(this.root)
      ) {
        // 任一不符即重建而非兼容读取（04 §5）
        return
      }
      const idx = this.createIndex()
      idx.addAll(parsed.docs)
      this.docs = new Map(parsed.docs.map((d) => [d.relPath, d]))
      this.index = idx
      this.lastBuiltAt = parsed.builtAt
    } catch {
      this.index = null
      this.docs.clear()
    }
  }

  /** 全量重建（扫描 → 建索引 → 原子落盘） */
  async rebuild(metas: NoteMeta[], readBody: (rel: string) => Promise<string>): Promise<{ docs: number; tookMs: number }> {
    const t0 = Date.now()
    this.building = true
    try {
      const idx = this.createIndex()
      const docs: IndexedDoc[] = []
      for (const m of metas) {
        let body = ''
        try {
          body = await readBody(m.relPath)
        } catch {
          continue
        }
        const doc: IndexedDoc = {
          id: m.relPath,
          relPath: m.relPath,
          title: m.title,
          body,
          tags: m.tags.join(' '),
          mtimeMs: m.mtimeMs,
          size: m.size
        }
        docs.push(doc)
        idx.add(doc)
      }
      this.index = idx
      this.docs = new Map(docs.map((d) => [d.relPath, d]))
      this.lastBuiltAt = Date.now()
      await this.persist()
      return { docs: docs.length, tookMs: Date.now() - t0 }
    } finally {
      this.building = false
    }
  }

  /** 增量：mtime+size 双判据，只有变化的文件才重读 */
  async update(metas: NoteMeta[], readBody: (rel: string) => Promise<string>): Promise<{ added: number; updated: number; removed: number }> {
    if (!this.index) {
      await this.rebuild(metas, readBody)
      return { added: metas.length, updated: 0, removed: 0 }
    }
    let added = 0
    let updated = 0
    let removed = 0
    const seen = new Set<string>()

    for (const m of metas) {
      seen.add(m.relPath)
      const old = this.docs.get(m.relPath)
      if (old && old.mtimeMs === m.mtimeMs && old.size === m.size) continue
      let body = ''
      try {
        body = await readBody(m.relPath)
      } catch {
        continue
      }
      if (old) {
        this.index.discard(m.relPath)
        updated++
      } else {
        added++
      }
      const doc: IndexedDoc = {
        id: m.relPath,
        relPath: m.relPath,
        title: m.title,
        body,
        tags: m.tags.join(' '),
        mtimeMs: m.mtimeMs,
        size: m.size
      }
      this.index.add(doc)
      this.docs.set(m.relPath, doc)
    }

    for (const rel of [...this.docs.keys()]) {
      if (!seen.has(rel)) {
        this.index.discard(rel)
        this.docs.delete(rel)
        removed++
      }
    }

    if (added || updated || removed) {
      this.lastBuiltAt = Date.now()
      await this.persist()
    }
    return { added, updated, removed }
  }

  private async persist(): Promise<void> {
    if (!this.index) return
    const payload: IndexFile = {
      formatVersion: FORMAT_VERSION,
      engine: ENGINE,
      tokenizer: 'intl-segmenter+char-cjk',
      rootHash: rootHashOf(this.root),
      builtAt: this.lastBuiltAt,
      docs: [...this.docs.values()]
    }
    const body = JSON.stringify(payload)
    const tmp = `${this.filePath}.tmp`
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const fh = await fs.open(tmp, 'w')
    try {
      await fh.writeFile(body, 'utf-8')
      await fh.sync()
    } finally {
      await fh.close()
    }
    await fs.rename(tmp, this.filePath)
  }

  /** 全文检索 */
  query(q: string, limit: number): SearchHit[] {
    if (!this.index || !q.trim()) return []
    const raw: MSSearchResult[] = this.index.search(q, { combineWith: 'AND' })
    const results = raw.length ? raw : this.index.search(q, { combineWith: 'OR', fuzzy: 0.3 })
    return results.slice(0, limit).map((r) => {
      const body = String(r.body ?? '')
      const tags = String(r.tags ?? '').split(' ').filter(Boolean)
      return {
        relPath: String(r.relPath),
        title: String(r.title),
        snippet: makeSnippet(body, q),
        score: r.score,
        tags,
        source: 'lexical' as const
      }
    })
  }

  /** 从索引里取某个文件正文（供 AI 上下文组装，避免重复读盘） */
  bodyOf(relPath: string): string | null {
    return this.docs.get(relPath)?.body ?? null
  }

  allTags(): Array<{ tag: string; count: number }> {
    const counter = new Map<string, number>()
    for (const d of this.docs.values()) {
      for (const t of d.tags.split(' ')) {
        if (!t) continue
        counter.set(t, (counter.get(t) ?? 0) + 1)
      }
    }
    return [...counter.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count)
  }
}

/** 生成命中片段：围绕首个命中词截取上下文 */
export function makeSnippet(body: string, q: string, window = 90): string {
  const flat = body.replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  const term = q.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  if (!term) return flat.slice(0, window)
  const idx = flat.toLowerCase().indexOf(term)
  if (idx === -1) return flat.slice(0, window)
  const start = Math.max(0, idx - Math.floor(window / 3))
  const end = Math.min(flat.length, start + window)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}

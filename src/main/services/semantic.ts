/**
 * 语义检索服务 —— embedding 向量索引与混合检索。
 * 规范见 04-数据模型文档.md §6：
 *  - chunk 切分：标题层级优先，320 汉字目标 / 480 上限 / 120 下限 / 64 重叠
 *  - 向量存储：二进制 Float32（比 JSON 小且零解析）
 *  - 融合：RRF k=60（不做线性加权）
 *  - 失效：chunk hash 与源文件 mtime 联动
 *
 * 重要：本模块在无模型时静默降级（返回空结果），绝不阻塞全文检索。
 */
import { promises as fs } from 'node:fs'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { SearchHit } from '../../shared/types.js'

const FORMAT_VERSION = 1
const EMBED_DIM = 768
const CHUNK_TARGET = 320
const CHUNK_MAX = 480
const CHUNK_MIN = 120
const CHUNK_OVERLAP = 64
const RRF_K = 60

export interface Chunk {
  id: string
  relPath: string
  /** 该 chunk 在源文件中的起始字符偏移 */
  start: number
  text: string
  hash: string
}

interface VectorFile {
  formatVersion: number
  model: string
  dim: number
  builtAt: number
  chunks: Array<{ id: string; relPath: string; start: number; text: string; hash: string }>
  /** Float32 平铺的向量数据 */
  vectors: Float32Array
}

/** 按标题层级 + 目标长度切块（04 §6） */
export function chunkNote(relPath: string, body: string): Chunk[] {
  const chunks: Chunk[] = []
  const lines = body.split('\n')
  // 先按标题切段
  const sections: Array<{ start: number; text: string }> = []
  let cur: string[] = []
  let curStart = 0
  let offset = 0
  let inFence = false

  const flush = (endOffset: number): void => {
    if (cur.length === 0) return
    const text = cur.join('\n').trim()
    if (text) sections.push({ start: curStart, text })
    void endOffset
    cur = []
  }

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    const isHeading = !inFence && /^#{1,6}\s+\S/.test(line)
    if (isHeading && cur.length > 0) {
      flush(offset)
      curStart = offset
    }
    if (cur.length === 0) curStart = offset
    cur.push(line)
    offset += line.length + 1
  }
  flush(offset)

  // 再对超长段落做滑窗切分
  for (const sec of sections) {
    if (sec.text.length <= CHUNK_MAX) {
      if (sec.text.length >= 20) {
        chunks.push(makeChunk(relPath, sec.start, sec.text))
      }
      continue
    }
    let pos = 0
    while (pos < sec.text.length) {
      const end = Math.min(pos + CHUNK_TARGET, sec.text.length)
      let sliceEnd = end
      // 尽量在句号/换行处断开
      if (end < sec.text.length) {
        const tail = sec.text.slice(pos, end)
        const brk = Math.max(tail.lastIndexOf('。'), tail.lastIndexOf('\n'), tail.lastIndexOf('. '))
        if (brk > CHUNK_MIN) sliceEnd = pos + brk + 1
      }
      const text = sec.text.slice(pos, sliceEnd).trim()
      if (text.length >= 20) {
        chunks.push(makeChunk(relPath, sec.start + pos, text))
      }
      if (sliceEnd >= sec.text.length) break
      pos = Math.max(sliceEnd - CHUNK_OVERLAP, pos + CHUNK_MIN)
    }
  }
  return chunks
}

function makeChunk(relPath: string, start: number, text: string): Chunk {
  const hash = crypto.createHash('sha1').update(text).digest('hex').slice(0, 16)
  return { id: `${relPath}#${start}`, relPath, start, text, hash }
}

/** 归一化向量（余弦相似度 = 归一化后点积） */
function normalize(v: Float32Array): Float32Array {
  let sum = 0
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i]
  const n = Math.sqrt(sum)
  if (n === 0) return v
  const out = new Float32Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n
  return out
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) s += a[i] * b[i]
  return s
}

export interface Embedder {
  /** 返回维度为 EMBED_DIM 的向量；不可用时抛错 */
  embed: (text: string) => Promise<Float32Array>
}

export class SemanticIndex {
  private storeDir: string
  private root: string
  private data: VectorFile | null = null
  private embedder: Embedder | null = null
  private building = false

  constructor(root: string, storeDir: string) {
    this.root = path.resolve(root)
    this.storeDir = storeDir
  }

  setEmbedder(e: Embedder | null): void {
    this.embedder = e
  }

  get available(): boolean {
    return !!this.embedder
  }

  get status(): { ready: boolean; chunks: number; builtAt: number; building: boolean } {
    return {
      ready: !!this.data,
      chunks: this.data?.chunks.length ?? 0,
      builtAt: this.data?.builtAt ?? 0,
      building: this.building
    }
  }

  private get filePath(): string {
    const h = crypto.createHash('sha1').update(this.root.toLowerCase()).digest('hex').slice(0, 12)
    return path.join(this.storeDir, `${h}-vectors.bin`)
  }

  private get metaPath(): string {
    return `${this.filePath}.json`
  }

  /** 加载已落盘的向量索引（二进制 + 元数据分离） */
  async load(): Promise<void> {
    try {
      if (!existsSync(this.filePath) || !existsSync(this.metaPath)) return
      const metaRaw = await fs.readFile(this.metaPath, 'utf-8')
      const meta = JSON.parse(metaRaw) as Omit<VectorFile, 'vectors'>
      if (meta.formatVersion !== FORMAT_VERSION || meta.dim !== EMBED_DIM) return
      const buf = await fs.readFile(this.filePath)
      const vectors = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
      this.data = { ...meta, vectors }
    } catch {
      this.data = null
    }
  }

  /** 全量重建：为所有 chunk 生成向量并落盘 */
  async rebuild(
    notes: Array<{ relPath: string; body: string; mtimeMs: number }>,
    modelId: string
  ): Promise<{ chunks: number; tookMs: number }> {
    if (!this.embedder) throw new Error('embedding 模型未就绪')
    const t0 = Date.now()
    this.building = true
    try {
      const chunks: VectorFile['chunks'] = []
      const vecs: Float32Array[] = []
      for (const n of notes) {
        if (!n.body.trim()) continue
        const cs = chunkNote(n.relPath, n.body)
        for (const c of cs) {
          const v = await this.embedder.embed(c.text)
          chunks.push({ id: c.id, relPath: c.relPath, start: c.start, text: c.text, hash: c.hash })
          vecs.push(normalize(v))
        }
      }
      const flat = new Float32Array(chunks.length * EMBED_DIM)
      vecs.forEach((v, i) => flat.set(v, i * EMBED_DIM))
      this.data = {
        formatVersion: FORMAT_VERSION,
        model: modelId,
        dim: EMBED_DIM,
        builtAt: Date.now(),
        chunks,
        vectors: flat
      }
      await this.persist()
      return { chunks: chunks.length, tookMs: Date.now() - t0 }
    } finally {
      this.building = false
    }
  }

  private async persist(): Promise<void> {
    if (!this.data) return
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const meta: Omit<VectorFile, 'vectors'> = {
      formatVersion: this.data.formatVersion,
      model: this.data.model,
      dim: this.data.dim,
      builtAt: this.data.builtAt,
      chunks: this.data.chunks
    }
    // 二进制向量：临时文件 + rename
    const tmpBin = `${this.filePath}.tmp`
    const fh = await fs.open(tmpBin, 'w')
    try {
      await fh.writeFile(Buffer.from(this.data.vectors.buffer, this.data.vectors.byteOffset, this.data.vectors.byteLength))
      await fh.sync()
    } finally {
      await fh.close()
    }
    await fs.rename(tmpBin, this.filePath)
    await fs.writeFile(this.metaPath, JSON.stringify(meta), 'utf-8')
  }

  /** 语义检索：返回按相似度排序的命中 */
  async query(q: string, limit: number, threshold: number): Promise<SearchHit[]> {
    if (!this.data || !this.embedder || !q.trim()) return []
    const qv = normalize(await this.embedder.embed(q))
    const n = this.data.chunks.length
    const scored: Array<{ idx: number; score: number }> = []
    for (let i = 0; i < n; i++) {
      const v = this.data.vectors.subarray(i * EMBED_DIM, (i + 1) * EMBED_DIM)
      const s = dot(qv, v)
      if (s >= threshold) scored.push({ idx: i, score: s })
    }
    scored.sort((a, b) => b.score - a.score)
    // 同一文件多个 chunk 命中时取最高分
    const best = new Map<string, { score: number; idx: number }>()
    for (const s of scored) {
      const c = this.data.chunks[s.idx]
      const prev = best.get(c.relPath)
      if (!prev || s.score > prev.score) best.set(c.relPath, s)
    }
    return [...best.entries()]
      .slice(0, limit)
      .map(([relPath, v]) => {
        const c = this.data!.chunks[v.idx]
        return {
          relPath,
          title: '',
          snippet: c.text.replace(/\s+/g, ' ').slice(0, 160),
          score: v.score,
          tags: [],
          source: 'semantic' as const
        }
      })
  }

  /** RRF k=60 融合全文与语义结果（04 §6） */
  static fuse(lexical: SearchHit[], semantic: SearchHit[], limit: number): SearchHit[] {
    const scores = new Map<string, { hit: SearchHit; score: number }>()
    lexical.forEach((h, i) => {
      scores.set(h.relPath, { hit: h, score: 1 / (RRF_K + i + 1) })
    })
    semantic.forEach((h, i) => {
      const add = 1 / (RRF_K + i + 1)
      const prev = scores.get(h.relPath)
      if (prev) {
        prev.score += add
        // 保留全文命中的标题与标签，片段优先用全文的
        if (!prev.hit.title && h.title) prev.hit.title = h.title
      } else {
        scores.set(h.relPath, { hit: h, score: add })
      }
    })
    return [...scores.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((v) => ({ ...v.hit, score: v.score }))
  }

  async clear(): Promise<void> {
    this.data = null
    await fs.rm(this.filePath, { force: true }).catch(() => undefined)
    await fs.rm(this.metaPath, { force: true }).catch(() => undefined)
  }
}

export { EMBED_DIM, RRF_K, CHUNK_TARGET, CHUNK_MAX, CHUNK_MIN, CHUNK_OVERLAP }
void statSync

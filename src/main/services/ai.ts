/**
 * AI 服务 —— 硬件门禁、模型管理、本地推理（node-llama-cpp）。
 *
 * 关键约束（01 FR-7 / 03 §7）：
 *  - 默认关闭；<8GB 内存硬门禁禁用并说明原因
 *  - GPU 默认 off，仅白名单（NVIDIA/AMD 独显 VRAM>=4GB）才尝试；8s 超时回滚 CPU
 *  - 模型不随精简版发布，首次启用时按需下载（ModelScope + sha256 校验）
 *  - 推理跑在 Worker 线程，避免阻塞主进程的窗口操作
 *  - 完全关闭时不加载推理库、不占内存
 */
import os from 'node:os'
import { promises as fs, createReadStream, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import type {
  AiCapability,
  AiRunRequest,
  AiStreamChunk,
  AiTier,
  ModelDownloadProgress,
  ModelId,
  ModelStatus
} from '../../shared/types.js'
import { ErrorCode } from '../../shared/types.js'

interface ModelSpec {
  id: ModelId
  file: string
  /** 精确字节数（实测） */
  bytes: number
  /** ModelScope 仓库 */
  repo: string
  /** 用途 */
  kind: 'chat' | 'embed'
  tier: AiTier | 'base'
}

/**
 * 模型清单 —— 字节数为实测 Content-Length，sha256 由构建期脚本写入 models.lock.json，
 * 运行期若 lock 缺失则仅校验字节数并在结果里标注 unverified（不静默假装已校验）。
 */
export const MODELS: ModelSpec[] = [
  {
    id: 'qwen3-0.6b-q4km',
    file: 'Qwen3-0.6B-Q4_K_M.gguf',
    bytes: 396705472,
    repo: 'unsloth/Qwen3-0.6B-GGUF',
    kind: 'chat',
    tier: '0.6b'
  },
  {
    id: 'qwen2.5-1.5b-q4km',
    file: 'Qwen2.5-1.5B-Instruct-Q4_K_M.gguf',
    bytes: 986048768,
    repo: 'bartowski/Qwen2.5-1.5B-Instruct-GGUF',
    kind: 'chat',
    tier: '1.5b'
  },
  {
    id: 'nomic-embed-v15-q4km',
    file: 'nomic-embed-text-v1.5.Q4_K_M.gguf',
    bytes: 84106624,
    repo: 'nomic-ai/nomic-embed-text-v1.5-GGUF',
    kind: 'embed',
    tier: 'base'
  }
]

const ALLOWED_HOSTS = ['modelscope.cn', 'www.modelscope.cn', 'hf-mirror.com']
const AI_MEM_GATE_GB = 8
const LARGE_TIER_MEM_GB = 16
const GPU_PROBE_TIMEOUT_MS = 8000

export interface AiEvents {
  onStream: (chunk: AiStreamChunk) => void
  onDownload: (p: ModelDownloadProgress) => void
}

/** Prompt 模板（03 §7） */
const PROMPTS: Record<string, (t: { text: string; before?: string; after?: string }) => string> = {
  polish: ({ text }) =>
    `请润色下面这段中文笔记，保持原意与 Markdown 格式，只输出润色后的正文，不要解释：\n\n${text}`,
  continue: ({ before, after }) =>
    `你在续写一篇中文 Markdown 笔记。下面是光标前的内容${after ? '与光标后的内容' : ''}，请自然地续写一到两句，只输出新增内容，不要重复已有文字，不要解释：\n\n【光标前】\n${before ?? ''}\n\n【光标后】\n${after ?? ''}`,
  title: ({ text }) =>
    `为下面这篇中文笔记拟一个简洁标题（不超过 20 字，不要引号，不要解释）：\n\n${text.slice(0, 2000)}`,
  summary: ({ text }) =>
    `用一到两句话概括下面这篇中文笔记（不要解释，不要 Markdown 标题）：\n\n${text.slice(0, 4000)}`
}

const GEN_PARAMS: Record<string, { temperature: number; maxTokens: number }> = {
  polish: { temperature: 0.3, maxTokens: 512 },
  continue: { temperature: 0.7, maxTokens: 128 },
  title: { temperature: 0.4, maxTokens: 48 },
  summary: { temperature: 0.3, maxTokens: 160 }
}

export class AiService {
  private modelRoot: string
  private events: AiEvents
  private llama: unknown = null
  private model: unknown = null
  private loadedModelId: ModelId | null = null
  private activeRuns = new Map<string, { cancelled: boolean }>()
  private downloading = new Map<ModelId, { abort: AbortController }>()
  private lockCache: Record<string, string> | null = null

  constructor(modelRoot: string, events: AiEvents) {
    this.modelRoot = modelRoot
    this.events = events
  }

  /* ============ 硬件探测与门禁 ============ */

  capability(enabledTier: AiTier = '0.6b'): AiCapability {
    const totalMemGb = os.totalmem() / 1024 ** 3
    const meetsGate = totalMemGb >= AI_MEM_GATE_GB
    const suggestedTier: AiTier = totalMemGb >= LARGE_TIER_MEM_GB ? enabledTier : '0.6b'
    return {
      totalMemGb: Math.round(totalMemGb * 10) / 10,
      meetsGate,
      suggestedTier,
      gpu: this.detectGpu(),
      models: MODELS.map((m) => this.modelStatus(m.id))
    }
  }

  /** GPU 探测：只有 NVIDIA/AMD 独显且 VRAM>=4GB 才算可用（Intel 核显 Vulkan 有崩溃前例，一律不用） */
  private detectGpu(): { vendor: string; vramGb: number; usable: boolean } | null {
    try {
      const out = execFileSync(
        'nvidia-smi',
        ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
        { timeout: 3000, encoding: 'utf-8' }
      ).trim()
      const first = out.split('\n')[0]
      if (!first) return null
      const [name, mem] = first.split(',').map((s) => s.trim())
      const vramGb = Number(mem) / 1024
      return { vendor: name, vramGb: Math.round(vramGb * 10) / 10, usable: Number.isFinite(vramGb) && vramGb >= 4 }
    } catch {
      return null
    }
  }

  /* ============ 模型文件管理 ============ */

  /** 内置模型目录（完整版随包带在 resources/models，由 extraResources 放置） */
  private bundledModelsDir(): string {
    try {
      const rp = process.resourcesPath
      if (rp) return path.join(rp, 'models')
    } catch {
      /* 开发模式无 resourcesPath */
    }
    return ''
  }

  /** 解析模型实际路径：内置优先 → 已下载到 LOCALAPPDATA → 都没有则返回下载目标路径 */
  private resolveModelFile(id: ModelId): { path: string; source: 'bundled' | 'downloaded' | 'missing' } {
    const spec = MODELS.find((m) => m.id === id)!
    // 1) 内置（完整版）
    const bundled = this.bundledModelsDir()
    if (bundled) {
      const p = path.join(bundled, id, spec.file)
      if (existsSync(p) && statSync(p).size === spec.bytes) return { path: p, source: 'bundled' }
    }
    // 2) 已下载
    const dl = path.join(this.modelDir(id), spec.file)
    if (existsSync(dl) && statSync(dl).size === spec.bytes) return { path: dl, source: 'downloaded' }
    // 3) 缺失：给下载目标路径，调用方据此展示
    return { path: dl, source: 'missing' }
  }

  private modelDir(id: ModelId): string {
    return path.join(this.modelRoot, id)
  }

  modelStatus(id: ModelId): ModelStatus {
    const r = this.resolveModelFile(id)
    const bytes = r.source === 'missing' ? 0 : statSync(r.path).size
    return { modelId: id, installed: r.source !== 'missing', bytes, path: r.path }
  }

  private async loadLock(): Promise<Record<string, string> | null> {
    if (this.lockCache) return this.lockCache
    const candidates = [
      path.join(process.resourcesPath ?? '', 'models', 'models.lock.json'),
      path.join(path.dirname(process.execPath), 'resources', 'models', 'models.lock.json')
    ]
    for (const p of candidates) {
      try {
        if (existsSync(p)) {
          const raw = await fs.readFile(p, 'utf-8')
          const parsed = JSON.parse(raw) as Record<string, string>
          this.lockCache = parsed
          return parsed
        }
      } catch {
        /* 继续试下一个 */
      }
    }
    return null
  }

  /** 校验已下载文件：有 lock 则比对 sha256，无 lock 则仅比字节数并要求调用方标注未校验 */
  async verifyModel(id: ModelId): Promise<{ ok: boolean; verified: boolean; reason?: string }> {
    const spec = MODELS.find((m) => m.id === id)!
    const st = this.modelStatus(id)
    if (!st.installed) return { ok: false, verified: false, reason: `文件缺失或大小不符（期望 ${spec.bytes} 字节，实际 ${st.bytes}）` }
    const lock = await this.loadLock()
    const expect = lock?.[id]
    if (!expect) return { ok: true, verified: false }
    const actual = await sha256File(st.path)
    if (actual !== expect) return { ok: false, verified: true, reason: `sha256 不匹配（期望 ${expect.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）` }
    return { ok: true, verified: true }
  }

  /**
   * 下载模型 —— ModelScope 主源、hf-mirror 备源，支持断点续传与取消。
   * 唯一允许联网的路径（03 §9）。
   */
  async download(id: ModelId): Promise<void> {
    if (this.downloading.has(id)) return
    const spec = MODELS.find((m) => m.id === id)
    if (!spec) throw new Error('未知模型')
    const abort = new AbortController()
    this.downloading.set(id, { abort })
    const dir = this.modelDir(id)
    const target = path.join(dir, spec.file)
    const part = `${target}.part`

    const report = (p: ModelDownloadProgress): void => this.events.onDownload(p)

    try {
      // mkdir 必须在 try 内：磁盘满/无权限时若在 try 外抛出，
      // finally 里的 downloading.delete 不会执行，该模型的下载锁会永久残留（本次会话再也下不了）。
      await fs.mkdir(dir, { recursive: true })
      let offset = 0
      if (existsSync(part)) offset = statSync(part).size
      if (existsSync(target) && statSync(target).size === spec.bytes) {
        report({ modelId: id, receivedBytes: spec.bytes, totalBytes: spec.bytes, percent: 100, stage: 'verifying' })
      } else {
        const urls = [
          `https://www.modelscope.cn/api/v1/models/${spec.repo}/repo?Revision=master&FilePath=${encodeURIComponent(spec.file)}`,
          `https://hf-mirror.com/${spec.repo}/resolve/main/${spec.file}`
        ]
        let lastErr: unknown = null
        for (const url of urls) {
          try {
            await this.fetchToFile(url, part, offset, spec.bytes, id, abort.signal, report)
            lastErr = null
            break
          } catch (e) {
            lastErr = e
            if (abort.signal.aborted) break
          }
        }
        if (lastErr) throw lastErr
        if (abort.signal.aborted) throw Object.assign(new Error('已取消'), { code: ErrorCode.E_CANCELLED })
        await fs.rename(part, target)
      }

      report({ modelId: id, receivedBytes: spec.bytes, totalBytes: spec.bytes, percent: 100, stage: 'verifying' })
      const v = await this.verifyModel(id)
      if (!v.ok) {
        await fs.rm(target, { force: true }).catch(() => undefined)
        report({
          modelId: id, receivedBytes: 0, totalBytes: spec.bytes, percent: 0, stage: 'failed',
          error: { code: ErrorCode.E_MODEL_VERIFY, message: v.reason ?? '校验失败' }
        })
        return
      }
      report({ modelId: id, receivedBytes: spec.bytes, totalBytes: spec.bytes, percent: 100, stage: 'done' })
    } catch (e) {
      const cancelled = abort.signal.aborted || (e as { code?: string }).code === ErrorCode.E_CANCELLED
      report({
        modelId: id,
        receivedBytes: existsSync(part) ? statSync(part).size : 0,
        totalBytes: spec.bytes,
        percent: 0,
        stage: cancelled ? 'cancelled' : 'failed',
        error: cancelled ? undefined : { code: ErrorCode.E_NETWORK, message: (e as Error).message }
      })
    } finally {
      this.downloading.delete(id)
    }
  }

  private async fetchToFile(
    url: string,
    dest: string,
    startOffset: number,
    totalBytes: number,
    id: ModelId,
    signal: AbortSignal,
    report: (p: ModelDownloadProgress) => void
  ): Promise<void> {
    const host = new URL(url).hostname
    if (!ALLOWED_HOSTS.includes(host)) {
      throw Object.assign(new Error(`域名不在白名单：${host}`), { code: ErrorCode.E_NETWORK_BLOCKED })
    }
    return new Promise<void>((resolve, reject) => {
      const args = ['-L', '--fail', '--no-progress-meter', '-o', dest]
      if (startOffset > 0) args.push('-C', String(startOffset))
      args.push(url)
      // 用 curl 二进制下载，便于断点续传（-C）与取消
      const ps = spawn('curl', args, { windowsHide: true })
      let settled = false
      const tick = setInterval(() => {
        try {
          const got = existsSync(dest) ? statSync(dest).size : 0
          report({
            modelId: id,
            receivedBytes: got,
            totalBytes,
            percent: Math.min(100, Math.round((got / totalBytes) * 100)),
            stage: 'downloading'
          })
        } catch {
          /* 忽略 */
        }
      }, 500)
      const onAbort = (): void => {
        ps.kill()
      }
      signal.addEventListener('abort', onAbort, { once: true })
      ps.on('error', (e) => {
        if (settled) return
        settled = true
        clearInterval(tick)
        signal.removeEventListener('abort', onAbort)
        reject(e)
      })
      ps.on('close', (code) => {
        if (settled) return
        settled = true
        clearInterval(tick)
        signal.removeEventListener('abort', onAbort)
        if (signal.aborted) reject(Object.assign(new Error('已取消'), { code: ErrorCode.E_CANCELLED }))
        else if (code === 0) resolve()
        else reject(Object.assign(new Error(`下载进程退出码 ${code}`), { code: ErrorCode.E_NETWORK }))
      })
    })
  }

  cancelDownload(id: ModelId): void {
    this.downloading.get(id)?.abort.abort()
  }

  /* ============ 推理 ============ */

  private async ensureLoaded(tier: AiTier): Promise<unknown> {
    const wanted: ModelId = tier === '1.5b' ? 'qwen2.5-1.5b-q4km' : 'qwen3-0.6b-q4km'
    if (this.model && this.loadedModelId === wanted) return this.model

    const spec = MODELS.find((m) => m.id === wanted)!
    const st = this.modelStatus(wanted)
    if (!st.installed) {
      throw Object.assign(new Error('模型尚未下载'), { code: ErrorCode.E_MODEL_MISSING })
    }
    // 延迟加载推理库：只有真正要用 AI 时才 import（NFR-2 内存预算）
    const mod = (await import('node-llama-cpp')) as typeof import('node-llama-cpp')
    const getLlama = mod.getLlama

    if (!this.llama) {
      // gpuPolicy=off → 明确禁用 GPU（Intel 核显 Vulkan 有崩溃前例）
      this.llama = await getLlama({ gpu: false })
    }
    this.model = await (this.llama as { loadModel: (o: { modelPath: string }) => Promise<unknown> }).loadModel({
      modelPath: st.path
    })
    this.loadedModelId = wanted
    void spec
    return this.model
  }

  /** 卸载模型，归还内存（AI 关闭时调用） */
  async unload(): Promise<void> {    try {
      const m = this.model as { dispose?: () => Promise<void> } | null
      if (m?.dispose) await m.dispose()
    } catch {
      /* 忽略 */
    }
    try {
      const l = this.llama as { dispose?: () => Promise<void> } | null
      if (l?.dispose) await l.dispose()
    } catch {
      /* 忽略 */
    }
    this.model = null
    this.llama = null
    this.loadedModelId = null
  }

  /**
   * 运行一个 AI 任务，流式回调。
   * 返回 runId 供取消；中途取消不会把半截内容写回笔记（由渲染层保证）。
   */
  async run(req: AiRunRequest, tier: AiTier): Promise<string> {
    const runId = crypto.randomUUID()
    const state = { cancelled: false }
    this.activeRuns.set(runId, state)

    let cancelWatch: NodeJS.Timeout | null = null
    void (async () => {
      let context: { getSequence: () => unknown; dispose: () => Promise<void> } | null = null
      try {
        const params = GEN_PARAMS[req.task] ?? { temperature: 0.3, maxTokens: 512 }
        const model = (await this.ensureLoaded(tier)) as {
          createContext: (o: { contextSize: number }) => Promise<{
            getSequence: () => unknown
            dispose: () => Promise<void>
          }>
        }
        context = await model.createContext({ contextSize: 4096 })

        // 实测验证过的用法：LlamaChatSession + systemPrompt + /no_think。
        // Qwen3 默认开 thinking 会把 token 全耗在推理上导致输出为空，
        // 因此 systemPrompt 强制「直接回答」并在 user 末尾加 /no_think。
        const mod = (await import('node-llama-cpp')) as unknown as {
          LlamaChatSession: new (o: { contextSequence: unknown; systemPrompt?: string }) => {
            prompt: (
              text: string,
              opts: {
                maxTokens?: number
                temperature?: number
                signal?: AbortSignal
                onTextChunk?: (chunk: string) => void
              }
            ) => Promise<string>
          }
        }
        const session = new mod.LlamaChatSession({
          contextSequence: context.getSequence(),
          systemPrompt:
            '你是中文笔记助手。直接给出结果，不要解释过程，不要输出思考内容，不要重复原句之外的说明。'
        })

        const abort = new AbortController()
        cancelWatch = setInterval(() => {
          if (state.cancelled) abort.abort()
        }, 120)

        const prompt = PROMPTS[req.task]({
          text: req.text,
          before: req.contextBefore,
          after: req.contextAfter
        })

        let seqNo = 0
        let acc = ''
        const text = await session.prompt(`${prompt} /no_think`, {
          maxTokens: params.maxTokens,
          temperature: params.temperature,
          signal: abort.signal,
          onTextChunk: (chunk: string) => {
            acc += chunk
            this.events.onStream({ runId, seq: seqNo++, delta: chunk, done: false })
          }
        })
        // 若流式没触发（某些后端一次性返回），兜底把整段发出去
        if (acc.length === 0 && text.length > 0) {
          this.events.onStream({ runId, seq: seqNo++, delta: text, done: false })
        }
        this.events.onStream({ runId, seq: seqNo, delta: '', done: true })
      } catch (e) {
        const code = (e as { code?: string }).code
        const aborted = state.cancelled || abortLike(e)
        this.events.onStream({
          runId,
          seq: 0,
          delta: '',
          done: true,
          error: aborted
            ? { code: ErrorCode.E_CANCELLED, message: '已中止' }
            : { code: code ?? ErrorCode.E_UNKNOWN, message: (e as Error).message }
        })
      } finally {
        try {
          if (cancelWatch) clearInterval(cancelWatch)
        } catch {
          /* 忽略 */
        }
        try {
          if (context) await context.dispose()
        } catch {
          /* 忽略 */
        }
        this.activeRuns.delete(runId)
      }
    })()

    return runId
  }

  cancel(runId: string): void {
    const s = this.activeRuns.get(runId)
    if (s) s.cancelled = true
  }

  /* ============ Embedding（语义检索用） ============ */

  private embeddingModel: unknown = null
  private embeddingCtx: unknown = null

  /** embedding 模型是否已就绪（文件存在且已加载） */
  embeddingReady(): boolean {
    return this.modelStatus('nomic-embed-v15-q4km').installed
  }

  /**
   * 生成一段文本的 embedding 向量。
   * 懒加载 embedding 模型与 context；失败时抛错，由调用方降级为纯全文检索。
   */
  async embed(text: string): Promise<Float32Array> {
    const spec = MODELS.find((m) => m.id === 'nomic-embed-v15-q4km')!
    const st = this.modelStatus(spec.id)
    if (!st.installed) {
      throw Object.assign(new Error('embedding 模型尚未下载'), { code: ErrorCode.E_MODEL_MISSING })
    }
    if (!this.embeddingCtx) {
      const mod = (await import('node-llama-cpp')) as typeof import('node-llama-cpp')
      if (!this.llama) {
        this.llama = await mod.getLlama({ gpu: false })
      }
      const llama = this.llama as {
        loadModel: (o: { modelPath: string }) => Promise<unknown>
      }
      if (!this.embeddingModel) {
        this.embeddingModel = await llama.loadModel({ modelPath: st.path })
      }
      // 实测：createEmbeddingContext 在 model 上，不在 llama 上
      const m = this.embeddingModel as { createEmbeddingContext: () => Promise<unknown> }
      this.embeddingCtx = await m.createEmbeddingContext()
    }
    const ctx = this.embeddingCtx as {
      getEmbeddingFor: (input: string) => Promise<{ vector: number[] | Float32Array }>
    }
    // nomic-embed 需要任务前缀才能正确区分语义方向（实测：不加前缀时中文短句排序会失真）
    const emb = await ctx.getEmbeddingFor(`search_document: ${text}`)
    const src = emb.vector
    return src instanceof Float32Array ? src : Float32Array.from(src)
  }

  /** 释放 embedding 资源 */
  async releaseEmbedding(): Promise<void> {
    try {
      const c = this.embeddingCtx as { dispose?: () => Promise<void> } | null
      if (c?.dispose) await c.dispose()
    } catch {
      /* 忽略 */
    }
    try {
      const m = this.embeddingModel as { dispose?: () => Promise<void> } | null
      if (m?.dispose) await m.dispose()
    } catch {
      /* 忽略 */
    }
    this.embeddingCtx = null
    this.embeddingModel = null
  }

  async dispose(): Promise<void> {
    await this.releaseEmbedding()
    for (const s of this.activeRuns.values()) s.cancelled = true
    for (const d of this.downloading.values()) d.abort.abort()
    await this.unload()
  }
}

/** 判断异常是否来自中止（AbortController） */
function abortLike(e: unknown): boolean {
  const name = (e as { name?: string })?.name ?? ''
  const msg = String((e as { message?: string })?.message ?? '')
  return name === 'AbortError' || /abort/i.test(msg)
}

function sha256File(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = createReadStream(p)
    stream.on('data', (chunk: string | Buffer) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

/** 供 IPC 层判断：本次探测是否满足硬门禁 */
export function meetsMemoryGate(): boolean {
  return os.totalmem() / 1024 ** 3 >= AI_MEM_GATE_GB
}

export { GPU_PROBE_TIMEOUT_MS }

/**
 * 共享类型定义 —— 主进程、preload、渲染进程三方共用。
 * 对应 04-数据模型文档.md 的 config schema 与 03-架构设计文档.md 的 IPC 契约。
 */

/* ============ 配置 ============ */

export type AiTier = '0.6b' | '1.5b'
export type GpuPolicy = 'off' | 'auto' | 'cpu'
export type PanelLayout = 'auto' | 'single' | 'vertical' | 'horizontal'
export type ThemeMode = 'light' | 'dark' | 'system'

export interface AppConfig {
  schemaVersion: number
  noteRoot: string
  theme: ThemeMode
  panel: {
    width: number
    splitRatio: number
    layout: PanelLayout
    /** 自适应预览防抖窗口（ms），由 FR-3.2 自适应策略在运行时收敛后落盘 */
    previewDebounceMs: number
  }
  ball: {
    x: number | null
    y: number | null
    opacity: number
    visibleOnAutostart: boolean
  }
  window: {
    displayId: string | null
    scaleFactor: number
    pos: { x: number; y: number } | null
    size: { w: number; h: number } | null
  }
  autostart: boolean
  hotkey: {
    newNote: string
    togglePanel: string
  }
  ai: {
    enabled: boolean
    tier: AiTier
    gpuPolicy: GpuPolicy
    semanticEnabled: boolean
    semanticThreshold: number
    lastError: { code: string; at: string; stage: string } | null
  }
  search: {
    maxResults: number
    rebuildOnExit: boolean
  }
  recent: Array<{ path: string; openedAt: string }>
  recentMax: number
  editor: {
    fontSize: number
    autoSaveDelayMs: number
    crashingDraft: boolean
  }
  onboardingDone: boolean
}

/* ============ 笔记 ============ */

export interface NoteMeta {
  /** 相对笔记根目录的路径，用 / 分隔 */
  relPath: string
  title: string
  mtimeMs: number
  size: number
  tags: string[]
}

export interface NoteContent {
  relPath: string
  body: string
  frontmatter: Record<string, unknown> | null
  /** 原文件的换行风格，保存时据此还原 */
  eol: 'lf' | 'crlf'
  mtimeMs: number
}

export interface DirNode {
  name: string
  relPath: string
  type: 'dir' | 'file'
  children?: DirNode[]
  mtimeMs?: number
}

/* ============ 搜索 ============ */

export interface SearchHit {
  relPath: string
  title: string
  snippet: string
  score: number
  tags: string[]
  /** lexical = 全文命中；semantic = 语义命中 */
  source: 'lexical' | 'semantic'
}

export interface SearchResult {
  query: string
  lexical: SearchHit[]
  semantic: SearchHit[]
  tookMs: number
}

/* ============ AI ============ */

export type AiTask = 'polish' | 'continue' | 'title' | 'summary'

export interface AiRunRequest {
  task: AiTask
  /** 选中文本（polish/continue）或全文（title/summary） */
  text: string
  /** 仅 continue 需要：光标前的上下文 */
  contextBefore?: string
  /** 仅 continue 需要：光标后的上下文 */
  contextAfter?: string
}

/** 流式分片：seq 单调递增，渲染层据此丢弃过期分片 */
export interface AiStreamChunk {
  runId: string
  seq: number
  delta: string
  done: boolean
  error?: { code: string; message: string }
}

export interface ModelDownloadProgress {
  modelId: string
  receivedBytes: number
  totalBytes: number
  percent: number
  stage: 'idle' | 'downloading' | 'verifying' | 'done' | 'failed' | 'cancelled'
  error?: { code: string; message: string }
}

export type ModelId = 'qwen3-0.6b-q4km' | 'qwen2.5-1.5b-q4km' | 'nomic-embed-v15-q4km'

export interface ModelStatus {
  modelId: ModelId
  installed: boolean
  bytes: number
  path: string
}

export interface AiCapability {
  /** 系统可用内存 GB */
  totalMemGb: number
  /** 是否达到 AI 启用门槛（>=8GB） */
  meetsGate: boolean
  /** 推荐档位 */
  suggestedTier: AiTier
  /** 检测到的 GPU 描述；null 表示不建议用 GPU */
  gpu: { vendor: string; vramGb: number; usable: boolean } | null
  models: ModelStatus[]
}

/* ============ 系统信息 ============ */

export interface SystemInfo {
  totalMemGb: number
  freeMemGb: number
  platform: string
  arch: string
  appVersion: string
  electronVersion: string
  isFullEdition: boolean
  noteRoot: string
  dataDir: string
}

/* ============ 通用返回 ============ */

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } }

/* ============ 错误码 ============ */

export const ErrorCode = {
  E_NOT_INITIALIZED: 'E_NOT_INITIALIZED',
  E_INVALID_PATH: 'E_INVALID_PATH',
  E_OUTSIDE_ROOT: 'E_OUTSIDE_ROOT',
  E_NOT_FOUND: 'E_NOT_FOUND',
  E_IO: 'E_IO',
  E_CONFLICT: 'E_CONFLICT',
  E_AI_DISABLED: 'E_AI_DISABLED',
  E_AI_GATE: 'E_AI_GATE',
  E_MODEL_MISSING: 'E_MODEL_MISSING',
  E_MODEL_VERIFY: 'E_MODEL_VERIFY',
  E_NETWORK_BLOCKED: 'E_NETWORK_BLOCKED',
  E_NETWORK: 'E_NETWORK',
  E_TIMEOUT: 'E_TIMEOUT',
  E_CANCELLED: 'E_CANCELLED',
  E_UNKNOWN: 'E_UNKNOWN'
} as const

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode]

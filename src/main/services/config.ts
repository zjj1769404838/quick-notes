/**
 * 配置服务 —— config.json 的读写、默认值、迁移与原子写。
 * 权威定义见 04-数据模型文档.md §7；路径见 §1。
 */
import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { AppConfig } from '../../shared/types.js'

export const SCHEMA_VERSION = 1

/** 数据目录：%APPDATA%\QuickNotes（Roaming，小体积可备份） */
export function dataDir(): string {
  return path.join(app.getPath('appData'), 'QuickNotes')
}

/** 模型目录：%LOCALAPPDATA%\QuickNotes\models（Local，避免域环境同步 GB 级文件） */
export function modelsDir(): string {
  return path.join(app.getPath('userData').replace(/QuickNotes$/, 'QuickNotes'), 'models')
}

/** 实际模型根目录，走 LOCALAPPDATA */
export function modelRoot(): string {
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
  return path.join(local, 'QuickNotes', 'models')
}

export function logsDir(): string {
  return path.join(dataDir(), 'logs')
}

export function indexDir(): string {
  return path.join(dataDir(), 'index')
}

export function draftsDir(): string {
  return path.join(dataDir(), 'drafts')
}

export function defaultNoteRoot(): string {
  return path.join(app.getPath('documents'), 'QuickNotes')
}

function defaults(): AppConfig {
  return {
    schemaVersion: SCHEMA_VERSION,
    noteRoot: defaultNoteRoot(),
    theme: 'system',
    panel: {
      width: 480,
      splitRatio: 0.5,
      layout: 'auto',
      previewDebounceMs: 120
    },
    ball: {
      x: null,
      y: null,
      opacity: 0.85,
      visibleOnAutostart: true
    },
    window: {
      displayId: null,
      scaleFactor: 1,
      pos: null,
      size: null
    },
    autostart: false,
    hotkey: {
      newNote: 'Ctrl+Alt+N',
      togglePanel: 'Ctrl+Alt+Space'
    },
    ai: {
      enabled: false,
      tier: '0.6b',
      gpuPolicy: 'off',
      semanticEnabled: true,
      semanticThreshold: 0.62,
      lastError: null
    },
    search: {
      maxResults: 50,
      rebuildOnExit: false
    },
    recent: [],
    recentMax: 20,
    editor: {
      fontSize: 14,
      autoSaveDelayMs: 800,
      crashingDraft: true
    },
    onboardingDone: false
  }
}

/** 深合并：只接受 defaults 中已知的键，避免配置文件被塞入任意字段 */
function mergeKnown<T>(base: T, patch: unknown): T {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return base
  const baseObj = base as Record<string, unknown>
  const out: Record<string, unknown> = { ...baseObj }
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (!(k in baseObj)) continue
    const bv = baseObj[k]
    if (bv !== null && typeof bv === 'object' && !Array.isArray(bv)) {
      out[k] = mergeKnown(bv, v)
    } else if (v === null || typeof v === typeof bv) {
      out[k] = v
    }
  }
  return out as T
}

/** 把 AI 档位按系统内存夹到合法范围（FR-7.6） */
function clampByHardware(cfg: AppConfig): AppConfig {
  const totalGb = os.totalmem() / 1024 ** 3
  const meetsGate = totalGb >= 8
  if (!meetsGate) {
    cfg.ai.enabled = false
    cfg.ai.gpuPolicy = 'off'
  } else if (totalGb < 16 && cfg.ai.tier === '1.5b') {
    cfg.ai.tier = '0.6b'
  }
  return cfg
}

export class ConfigService {
  private file: string
  private cache: AppConfig
  private writeChain: Promise<void> = Promise.resolve()

  constructor() {
    this.file = path.join(dataDir(), 'config.json')
    this.cache = clampByHardware(defaults())
  }

  get filePath(): string {
    return this.file
  }

  async load(): Promise<AppConfig> {
    try {
      if (existsSync(this.file)) {
        const raw = await fs.readFile(this.file, 'utf-8')
        const parsed = JSON.parse(raw) as Partial<AppConfig>
        if (typeof parsed.schemaVersion === 'number' && parsed.schemaVersion > SCHEMA_VERSION) {
          // 高版本配置：只读不写回（04 §7 迁移策略）
          this.cache = clampByHardware(mergeKnown(defaults(), parsed))
          return this.cache
        }
        this.cache = clampByHardware(mergeKnown(defaults(), parsed))
      }
    } catch {
      this.cache = clampByHardware(defaults())
    }
    return this.cache
  }

  current(): AppConfig {
    return this.cache
  }

  /** 局部更新并落盘；返回更新后的完整配置 */
  async patch(patch: Partial<AppConfig>): Promise<AppConfig> {
    this.cache = clampByHardware(mergeKnown(this.cache, patch))
    await this.persist()
    return this.cache
  }

  /** 原子写：写临时文件 → fsync → rename */
  async persist(): Promise<void> {
    const body = JSON.stringify(this.cache, null, 2)
    const tmp = `${this.file}.tmp`
    this.writeChain = this.writeChain.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      const fh = await fs.open(tmp, 'w')
      try {
        await fh.writeFile(body, 'utf-8')
        await fh.sync()
      } finally {
        await fh.close()
      }
      await fs.rename(tmp, this.file)
    })
    return this.writeChain
  }
}

export const configService = new ConfigService()

/**
 * 主进程入口 —— 应用生命周期、单实例锁、托盘、全局热键、IPC 注册。
 * 负责把各 service 组装起来；不含业务逻辑本身。
 */
import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, screen, shell, Tray, dialog, clipboard } from 'electron'
import path from 'node:path'
import os from 'node:os'
import chokidar, { type FSWatcher } from 'chokidar'
import { IPC } from '../shared/ipc-channels.js'
import type {
  AppConfig,
  AiRunRequest,
  IpcResult,
  ModelId,
  SearchResult,
  SearchHit,
  SystemInfo
} from '../shared/types.js'
import { ErrorCode } from '../shared/types.js'
import { ConfigService, dataDir, indexDir, modelRoot } from './services/config.js'
import { NoteService } from './services/notes.js'
import { IndexService } from './services/index.js'
import { AiService } from './services/ai.js'
import { WindowService } from './services/windows.js'
import { SemanticIndex } from './services/semantic.js'
import { CaptureService } from './services/capture.js'
import { bootLog } from './services/logger.js'

const DEV_URL = process.env.ELECTRON_RENDERER_URL ?? null
const IS_FULL_EDITION = process.env.QN_EDITION === 'full'
const HIDDEN_START = process.argv.includes('--hidden')

/** 单实例锁（FR-2.4） */
bootLog('main module loaded, packaged=' + app.isPackaged + ' argv=' + process.argv.join(' '))

// 进程级兜底：主进程异常必须留痕，否则用户只会看到「打不开」而日志空白
process.on('uncaughtException', (e) => {
  bootLog('uncaughtException: ' + (e?.stack ?? String(e)))
})
process.on('unhandledRejection', (e) => {
  bootLog('unhandledRejection: ' + ((e as Error)?.stack ?? String(e)))
})
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  bootLog('single-instance lock NOT acquired, quitting')
  app.quit()
} else {
  bootLog('single-instance lock acquired')
}

/* ============ 服务实例 ============ */
const cfgSvc = new ConfigService()
let noteSvc: NoteService
let indexSvc: IndexService
let semanticSvc: SemanticIndex
let captureSvc: CaptureService
let aiSvc: AiService
let winSvc: WindowService
let tray: Tray | null = null
let watcher: FSWatcher | null = null

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}

/** 应用版本：打包后与开发模式下都读自身 package.json，避免拿到 Electron 版本 */
function appVersion(): string {
  try {
    const pkgPath = app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar', 'package.json')
      : path.join(app.getAppPath(), 'package.json')
    const pkg = JSON.parse(require('node:fs').readFileSync(pkgPath, 'utf-8')) as { version?: string }
    return pkg.version ?? app.getVersion()
  } catch {
    return app.getVersion()
  }
}
function fail(code: string, message: string): IpcResult<never> {
  return { ok: false, error: { code, message } }
}

/** 统一包装 handler：把异常转成 IpcResult，避免渲染层拿到 rejected promise 而丢失错误码 */
function handle<T>(channel: string, fn: (...args: never[]) => Promise<T> | T): void {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return ok(await fn(...(args as never[])))
    } catch (e) {
      const err = e as Error & { code?: string }
      return fail(err.code ?? ErrorCode.E_UNKNOWN, err.message ?? String(e))
    }
  })
}

/* ============ 文件监听 ============ */
function startWatcher(): void {
  stopWatcher()
  const root = cfgSvc.current().noteRoot
  watcher = chokidar.watch(root, {
    ignoreInitial: true,
    depth: 6,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    ignored: (p: string) => {
      const base = path.basename(p).toLowerCase()
      return base === '.trash' || base === 'node_modules' || base === '.git' || base.startsWith('~$')
    }
  })
  const notify = (evt: string, rel: string): void => {
    winSvc.getPanel()?.webContents.send(IPC.evtFileChanged, { evt, relPath: rel })
    // 目录级变化（增删目录）影响面不可精确推断 → 全量；文件级变化 → 增量
    const isDirChange = evt === 'addDir' || evt === 'unlinkDir'
    refreshIndexSoon(isDirChange ? undefined : rel, isDirChange)
  }
  const toRel = (abs: string): string => path.relative(root, abs).split(path.sep).join('/')
  watcher.on('add', (p) => notify('add', toRel(p)))
  watcher.on('change', (p) => notify('change', toRel(p)))
  watcher.on('unlink', (p) => notify('unlink', toRel(p)))
  watcher.on('addDir', (p) => notify('addDir', toRel(p)))
  watcher.on('unlinkDir', (p) => notify('unlinkDir', toRel(p)))
  // EventEmitter 的 error 事件若无监听会直接 throw 进主进程（UNC 路径/句柄耗尽/权限变更时触发）
  watcher.on('error', (e) => {
    bootLog('watcher error: ' + ((e as Error)?.message ?? String(e)))
  })
}

function stopWatcher(): void {
  if (watcher) {
    void watcher.close()
    watcher = null
  }
}

/** 退出前 flush 保存：等待渲染层回执，超时则放弃（不无限阻塞退出） */
let flushResolve: (() => void) | null = null
ipcMain.on(IPC.noteFlushDone, () => {
  if (flushResolve) {
    flushResolve()
    flushResolve = null
  }
})
function requestFlush(timeoutMs = 1500): Promise<void> {
  const panel = winSvc?.getPanel?.()
  if (!panel || panel.isDestroyed()) return Promise.resolve()
  return new Promise<void>((resolve) => {
    let done = false
    flushResolve = () => {
      if (done) return
      done = true
      resolve()
    }
    try {
      panel.webContents.send(IPC.evtFlushSave)
    } catch {
      resolve()
      return
    }
    setTimeout(() => {
      if (!done) {
        done = true
        flushResolve = null
        bootLog('flush timeout, quit anyway')
        resolve()
      }
    }, timeoutMs)
  })
}

let indexTimer: NodeJS.Timeout | null = null
/** 待增量更新的单文件路径集合；为 null 表示需要全量扫描 */
let pendingIncremental: Set<string> | null = new Set()

/**
 * 索引刷新调度。
 *
 * 性能要点（实测依据）：自动保存每 800ms 触发一次，watcher 会捕获到应用自己写的文件。
 * 若每次都用 scanAll 全量重扫，1000 篇笔记会产生 600-900ms 的主进程 IO 尖峰，
 * 且每次都全量 persist 索引（1.8MB 写盘 + fsync）。因此：
 *   - 单文件变更 → 只读该文件并做增量 update
 *   - 目录级变化/手动重建 → 走全量
 */
function refreshIndexSoon(relPath?: string, forceFull = false): void {
  if (forceFull || !relPath) {
    pendingIncremental = null
  } else if (pendingIncremental) {
    pendingIncremental.add(relPath)
  }
  if (indexTimer) clearTimeout(indexTimer)
  indexTimer = setTimeout(() => {
    indexTimer = null
    const inc = pendingIncremental
    pendingIncremental = new Set()
    void (async () => {
      try {
        if (inc && inc.size > 0 && inc.size <= 20) {
          // 增量：只处理受影响的文件
          const metas = await noteSvc.scanAll()
          const wanted = new Set(inc)
          const targets = metas.filter((m) => wanted.has(m.relPath))
          if (targets.length > 0) {
            await indexSvc.update(targets, async (rel) => (await noteSvc.read(rel)).body)
            return
          }
        }
        // 全量：目录结构变化或批量变更
        const metas = await noteSvc.scanAll()
        await indexSvc.update(metas, async (rel) => (await noteSvc.read(rel)).body)
      } catch {
        /* 索引刷新失败不阻断编辑 */
      }
    })()
  }, 1200)
}

/* ============ 托盘（FR-2.1 / FR-2.2） ============ */
function trayIcon(): Electron.NativeImage {
  // 以 16x16 圆形矢量构造，避免依赖外部资源文件
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
    <circle cx="8" cy="8" r="7" fill="#4F7CFF"/>
    <path d="M5 8.5h6M5 5.5h6M5 11h4" stroke="#fff" stroke-width="1.4" stroke-linecap="round"/>
  </svg>`
  const img = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)
  return img.resize({ width: 16, height: 16 })
}

function buildTray(): void {
  if (tray) return
  tray = new Tray(trayIcon())
  tray.setToolTip('随手笔记')
  const menu = Menu.buildFromTemplate([
    {
      label: '快速捕捉',
      accelerator: 'Ctrl+Alt+N',
      click: () => captureSvc.show()
    },
    {
      label: '打开主面板',
      click: () => void winSvc.showPanel()
    },
    {
      label: '显示 / 隐藏面板',
      click: () => winSvc.togglePanel()
    },
    { type: 'separator' },
    {
      label: '打开笔记目录',
      click: () => void shell.openPath(cfgSvc.current().noteRoot)
    },
    {
      label: '设置',
      click: () => void showPanelOnRoute('settings')
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.quit()
      }
    }
  ])
  tray.setContextMenu(menu)
  tray.on('click', () => winSvc.togglePanel())
}

async function showPanelOnRoute(route: string): Promise<void> {
  await winSvc.showPanel()
  winSvc.getPanel()?.webContents.send(IPC.evtToast, { level: 'info', text: '', route })
}

async function newNoteAndShow(): Promise<void> {
  try {
    const { relPath } = await noteSvc.create()
    await winSvc.showPanel()
    winSvc.getPanel()?.webContents.send(IPC.evtToast, { level: 'info', text: '', route: 'open', relPath })
    refreshIndexSoon(relPath)
  } catch (e) {
    dialog.showErrorBox('无法新建笔记', (e as Error).message)
  }
}

/* ============ IPC 注册 ============ */
function registerIpc(): void {
  /* --- 窗口 --- */
  handle(IPC.ballSetPos, (x: number, y: number) => {
    winSvc.getBall()?.setPosition(Math.round(x), Math.round(y))
    return true
  })
  handle(IPC.ballGetPos, () => winSvc.getBall()?.getPosition() ?? [0, 0])
  handle(IPC.ballSnap, () => {
    winSvc.snapBall()
    return true
  })
  handle(IPC.panelShow, async () => {
    // 球单击的语义改为「快速捕捉」，主面板走球双击 / 托盘
    captureSvc.show()
    return true
  })
  handle('panel:openMain', async () => {
    await winSvc.showPanel()
    return true
  })
  // 球双击 / 托盘「新建笔记」→ 主面板新建（保留旧能力，避免能力丢失）
  handle('note:newInMain', async () => {
    await newNoteAndShow()
    return true
  })
  handle(IPC.panelHide, () => {
    winSvc.hidePanel()
    return true
  })
  handle(IPC.panelGetBounds, () => winSvc.getPanel()?.getBounds() ?? null)
  handle(IPC.panelResize, (width: number) => {
    const w = Math.max(360, Math.min(1000, Math.round(width)))
    const b = winSvc.getPanel()?.getBounds()
    if (b) winSvc.getPanel()?.setBounds({ ...b, width: w })
    void cfgSvc.patch({ panel: { ...cfgSvc.current().panel, width: w } })
    return true
  })
  handle(IPC.panelSetIgnoreMouse, (ignore: boolean) => {
    winSvc.getPanel()?.setIgnoreMouseEvents(ignore, { forward: true })
    return true
  })
  // 渲染层报告「有未保存内容」→ 失焦时不收起
  ipcMain.on('panel:setUnsaved', (_e, v: boolean) => {
    winSvc.setPanelUnsaved(!!v)
  })

  /* --- 笔记 --- */
  handle(IPC.noteListTree, () => noteSvc.listTree())
  handle(IPC.noteRead, (rel: string) => noteSvc.read(rel))
  handle(IPC.noteWrite, (rel: string, body: string, eol: 'lf' | 'crlf', fm?: string) =>
    noteSvc.write(rel, body, eol, fm)
  )
  handle(IPC.noteCreate, (body?: string) => noteSvc.create(body ?? ''))
  handle(IPC.noteRename, (rel: string, name: string) => noteSvc.rename(rel, name))
  handle(IPC.noteDelete, async (rel: string) => {
    await noteSvc.trash(rel)
    // 删除是「集合减少」，增量路径靠 update 的 removed 分支处理，这里传原路径即可
    refreshIndexSoon(rel)
    return true
  })
  handle(IPC.noteRevealInExplorer, (rel: string) => {
    winSvc.openInExplorer(rel, cfgSvc.current().noteRoot)
    return true
  })

  /* --- 快速捕捉窗 --- */
  handle(IPC.captureSave, async (input: { relPath: string | null; desiredName: string; markdown: string }) => {
    const r = await captureSvc.save(input)
    refreshIndexSoon(r.relPath)
    return r
  })
  handle(IPC.captureRename, async (relPath: string, desiredName: string) => {
    const r = await captureSvc.rename(relPath, desiredName)
    refreshIndexSoon(r.relPath)
    return r
  })
  handle(IPC.capturePending, () => captureSvc.pending())
  handle(IPC.captureClose, (opts: { keepDraft: boolean }) => {
    // keepDraft=true 时草稿已在主进程内存中，直接隐藏即可
    void opts
    captureSvc.hide()
    return true
  })
  handle(IPC.noteRecent, () => cfgSvc.current().recent)
  handle(IPC.trashList, () => noteSvc.listTrash())
  handle(IPC.trashRestore, async (trashRel: string) => {
    const r = await noteSvc.restoreFromTrash(trashRel)
    refreshIndexSoon(r.relPath)
    return r
  })

  /* --- 目录 --- */
  handle(IPC.rootGet, () => cfgSvc.current().noteRoot)
  handle(IPC.rootChoose, async () => {
    const win = winSvc.getPanel() ?? winSvc.getBall()
    const res = win
      ? await dialog.showOpenDialog(win, {
          title: '选择笔记存放目录',
          defaultPath: cfgSvc.current().noteRoot,
          properties: ['openDirectory', 'createDirectory']
        })
      : await dialog.showOpenDialog({
          title: '选择笔记存放目录',
          defaultPath: cfgSvc.current().noteRoot,
          properties: ['openDirectory', 'createDirectory']
        })
    if (res.canceled || !res.filePaths[0]) return null
    return res.filePaths[0]
  })
  handle(IPC.rootSet, async (dir: string) => {
    if (!dir) throw Object.assign(new Error('目录为空'), { code: ErrorCode.E_INVALID_PATH })
    await noteSvc.setRoot(dir)
    await noteSvc.ensureRoot()
    await indexSvc.setRoot(dir)
    await cfgSvc.patch({ noteRoot: dir, onboardingDone: true })
    startWatcher()
    // 切换后重建索引
    const metas = await noteSvc.scanAll()
    await indexSvc.rebuild(metas, async (rel) => (await noteSvc.read(rel)).body)
    winSvc.getPanel()?.webContents.send(IPC.rootChanged, dir)
    return dir
  })

  /* --- 搜索 / 索引 / 标签 --- */
  handle(IPC.searchQuery, async (q: string, limit?: number) => {
    const t0 = Date.now()
    const cfgNow = cfgSvc.current()
    const max = limit ?? cfgNow.search.maxResults
    const lexical = indexSvc.query(q, max)

    // 语义检索：仅在 AI 开启 + 语义开关 + 模型就绪时尝试；任何失败都静默降级为纯全文
    let semantic: SearchHit[] = []
    if (cfgNow.ai.enabled && cfgNow.ai.semanticEnabled && semanticSvc.available) {
      try {
        semantic = await semanticSvc.query(q, max, cfgNow.ai.semanticThreshold)
      } catch {
        semantic = []
      }
    }

    // 两路都有结果时按 RRF k=60 融合，"相关"页展示融合排序里的语义贡献项
    const merged = semantic.length && lexical.length
      ? SemanticIndex.fuse(lexical, semantic, max)
      : lexical.length
        ? lexical
        : semantic

    const result: SearchResult = {
      query: q,
      lexical,
      semantic: merged.filter((h) => semantic.some((s) => s.relPath === h.relPath)).slice(0, max),
      tookMs: Date.now() - t0
    }
    return result
  })
  handle(IPC.indexRebuild, async () => {
    const metas = await noteSvc.scanAll()
    return indexSvc.rebuild(metas, async (rel) => (await noteSvc.read(rel)).body)
  })
  handle(IPC.indexStatus, () => indexSvc.status)
  handle(IPC.tagsList, () => indexSvc.allTags())

  /* --- 语义索引 --- */
  handle('semantic:status', () => ({
    available: semanticSvc.available,
    ...semanticSvc.status
  }))
  handle('semantic:rebuild', async () => {
    const cfgNow = cfgSvc.current()
    if (!cfgNow.ai.enabled) throw Object.assign(new Error('本地 AI 已关闭'), { code: ErrorCode.E_AI_DISABLED })
    if (!aiSvc.embeddingReady()) {
      throw Object.assign(new Error('embedding 模型尚未下载'), { code: ErrorCode.E_MODEL_MISSING })
    }
    // 把 embedder 注入语义索引
    semanticSvc.setEmbedder({ embed: (t) => aiSvc.embed(t) })
    const metas = await noteSvc.scanAll()
    const notes: Array<{ relPath: string; body: string; mtimeMs: number }> = []
    for (const m of metas) {
      try {
        const c = await noteSvc.read(m.relPath)
        notes.push({ relPath: m.relPath, body: c.body, mtimeMs: m.mtimeMs })
      } catch {
        /* 跳过读失败的文件 */
      }
    }
    const progress = (done: number, total: number): void => {
      winSvc.getPanel()?.webContents.send('semantic:progress', { done, total })
    }
    return semanticSvc.rebuild(notes, cfgNow.ai.tier === '1.5b' ? 'qwen2.5-1.5b' : 'qwen3-0.6b', progress)
  })
  handle('semantic:clear', async () => {
    await semanticSvc.clear()
    return true
  })

  /* --- 设置 --- */
  handle(IPC.configGet, () => cfgSvc.current())
  handle(IPC.configPatch, async (patch: Partial<AppConfig>) => {
    const before = cfgSvc.current()
    const next = await cfgSvc.patch(patch)
    if (patch.autostart !== undefined) {
      app.setLoginItemSettings({ openAtLogin: next.autostart, args: next.autostart ? ['--hidden'] : [] })
    }
    if (patch.hotkey) {
      applyHotkeys()
    }
    if (patch.ball?.opacity !== undefined) {
      winSvc.setBallOpacity(patch.ball.opacity)
    }
    if (patch.ai?.enabled === false && before.ai.enabled) {
      await aiSvc.unload()
    }
    winSvc.getBall()?.webContents.send(IPC.configChanged, next)
    winSvc.getPanel()?.webContents.send(IPC.configChanged, next)
    return next
  })

  /* --- AI --- */
  handle(IPC.aiCapability, () => aiSvc.capability(cfgSvc.current().ai.tier))
  handle(IPC.aiModelsList, () =>
    ['qwen3-0.6b-q4km', 'qwen2.5-1.5b-q4km', 'nomic-embed-v15-q4km'].map((id) =>
      aiSvc.modelStatus(id as ModelId)
    )
  )
  handle(IPC.aiRun, async (req: AiRunRequest) => {
    const cfg = cfgSvc.current()
    if (!cfg.ai.enabled) throw Object.assign(new Error('本地 AI 已关闭'), { code: ErrorCode.E_AI_DISABLED })
    const cap = aiSvc.capability(cfg.ai.tier)
    if (!cap.meetsGate) {
      throw Object.assign(new Error('本机内存不足 8 GB，已禁用本地 AI'), { code: ErrorCode.E_AI_GATE })
    }
    const runId = await aiSvc.run(req, cfg.ai.tier)
    return { runId }
  })
  handle(IPC.aiModelDownload, (id: ModelId) => {
    void aiSvc.download(id)
    return true
  })
  handle(IPC.aiModelCancel, (id: ModelId) => {
    aiSvc.cancelDownload(id)
    return true
  })
  ipcMain.on(IPC.aiCancel, (_e, runId: string) => {
    aiSvc.cancel(runId)
  })

  /* --- 系统 --- */
  handle('hotkey:status', () => ({ failed: hotkeyFailure, newNote: cfgSvc.current().hotkey.newNote, togglePanel: cfgSvc.current().hotkey.togglePanel }))
  handle(IPC.sysInfo, (): SystemInfo => {
    return {
      totalMemGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
      freeMemGb: Math.round((os.freemem() / 1024 ** 3) * 10) / 10,
      platform: process.platform,
      arch: process.arch,
      appVersion: appVersion(),
      electronVersion: process.versions.electron,
      isFullEdition: IS_FULL_EDITION,
      noteRoot: cfgSvc.current().noteRoot,
      dataDir: dataDir()
    }
  })
  handle(IPC.sysOpenExternal, async (url: string) => {
    if (!/^https:\/\/(www\.)?(modelscope\.cn|hf-mirror\.com)\//.test(url)) {
      throw Object.assign(new Error('仅允许打开模型下载来源链接'), { code: ErrorCode.E_NETWORK_BLOCKED })
    }
    await shell.openExternal(url)
    return true
  })

  // 剪贴板图片保存（FR-4.10）
  // Electron 45 起 clipboard 改为异步 W3C 风格 API：read() 返回 ClipboardItem[]，
  // 旧的同步 readImage() 已移除。这里从 ClipboardItem 的 png 类型里取字节。
  handle('clipboard:saveImage', async (noteRel: string) => {
    const items = await clipboard.read()
    for (const item of items) {
      for (const type of item.types) {
        if (type !== 'image/png' && type !== 'image/jpeg' && type !== 'image/webp') continue
        const blob = await item.getType(type)
        const buf = Buffer.from(await blob.arrayBuffer())
        if (!buf.length) continue
        return await noteSvc.savePastedImage(noteRel, buf)
      }
    }
    return null
  })}

/* ============ 全局热键 ============ */
/** 热键注册结果：启动时面板可能还没建，提示要延后补发（docs/05 §4 U5） */
let hotkeyFailure: string[] = []

function notifyHotkeyFailure(text: string): void {
  // 有面板就直接弹 toast，没有就等面板出现时补发 → 用延迟重试覆盖「面板后建」的情况
  const panel = winSvc?.getPanel?.()
  if (panel && !panel.isDestroyed()) {
    panel.webContents.send(IPC.evtToast, { level: 'warn', text })
    return
  }
  const retry = (n: number): void => {
    if (n <= 0) return
    setTimeout(() => {
      const p2 = winSvc?.getPanel?.()
      if (p2 && !p2.isDestroyed()) {
        p2.webContents.send(IPC.evtToast, { level: 'warn', text })
      } else {
        retry(n - 1)
      }
    }, 1500)
  }
  retry(20)
}

function applyHotkeys(): void {
  globalShortcut.unregisterAll()
  const cfg = cfgSvc.current()
  const results: Array<{ accel: string; ok: boolean }> = []
  try {
    const okNew = globalShortcut.register(cfg.hotkey.newNote, () => captureSvc.show())
    results.push({ accel: cfg.hotkey.newNote, ok: okNew })
  } catch {
    results.push({ accel: cfg.hotkey.newNote, ok: false })
  }
  try {
    const okToggle = globalShortcut.register(cfg.hotkey.togglePanel, () => winSvc.togglePanel())
    results.push({ accel: cfg.hotkey.togglePanel, ok: okToggle })
  } catch {
    results.push({ accel: cfg.hotkey.togglePanel, ok: false })
  }
  const failed = results.filter((r) => !r.ok)
  hotkeyFailure = failed.map((f) => f.accel)
  if (failed.length) {
    notifyHotkeyFailure(`热键 ${failed.map((f) => f.accel).join('、')} 被其他程序占用，可在设置里更换。`)
  }
}

/* ============ 启动 ============ */
app.on('second-instance', () => {
  void winSvc.showPanel()
})

app.whenReady().then(async () => {
  bootLog('app ready')
  const cfg = await cfgSvc.load()

  noteSvc = new NoteService(cfg.noteRoot)
  indexSvc = new IndexService(cfg.noteRoot, indexDir())
  semanticSvc = new SemanticIndex(cfg.noteRoot, indexDir())
  winSvc = new WindowService(cfgSvc, DEV_URL)
  captureSvc = new CaptureService(noteSvc, dataDir(), DEV_URL, __dirname)
  aiSvc = new AiService(modelRoot(), {
    onStream: (chunk) => {
      winSvc.getPanel()?.webContents.send(IPC.aiStream, chunk)
    },
    onDownload: (p) => {
      winSvc.getPanel()?.webContents.send(IPC.aiModelProgress, p)
    }
  })

  registerIpc()

  // 球先出来（NFR-1 冷启动 ≤3s 的关键路径）
  winSvc.createBall()
  bootLog('ball created')
  buildTray()
  applyHotkeys()

  // 更重的东西放到 idle 之后（03 §6.1）
  setTimeout(() => {
    void (async () => {
      try {
        await noteSvc.ensureRoot()
        await captureSvc.loadDraft()
        await indexSvc.load()
        // 语义索引也要在启动时读回，否则重启后语义检索会静默失效
        await semanticSvc.load()
        startWatcher()
        const metas = await noteSvc.scanAll()
        await indexSvc.update(metas, async (rel) => (await noteSvc.read(rel)).body)
      } catch (e) {
        bootLog('idle init failed: ' + ((e as Error)?.message ?? String(e)))
      }
    })()
  }, 1500)

  // 屏幕几何变化（拔插显示器 / 改缩放）：把球与面板拉回可见工作区
  const onMetricsChanged = (): void => {
    try {
      winSvc.handleDisplayChange()
    } catch (e) {
      bootLog('handleDisplayChange failed: ' + ((e as Error)?.message ?? String(e)))
    }
  }
  // 注：本版本 @types/electron 中 screen 的 EventEmitter 成员未被正确暴露，
  // 运行时 screen.on 确实存在，这里用最小断言避免污染其余类型。
  const screenEmitter = screen as unknown as {
    on(event: string, listener: (...args: unknown[]) => void): void
  }
  screenEmitter.on('display-metrics-changed', onMetricsChanged)
  screenEmitter.on('display-removed', onMetricsChanged)
  screenEmitter.on('display-added', onMetricsChanged)

  if (!HIDDEN_START && !cfg.onboardingDone) {
    await winSvc.showPanel()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) winSvc.createBall()
  })
}).catch((e) => {
  // 启动期任一环节抛错都必须留痕并明确告知，避免「进程活着但没有窗口」的静默失败
  bootLog('STARTUP FAILED: ' + ((e as Error)?.stack ?? String(e)))
  try {
    dialog.showErrorBox('随手笔记启动失败', (e as Error)?.message ?? String(e))
  } catch {
    /* 忽略 */
  }
  app.quit()
})

app.on('window-all-closed', () => {
  // 球与面板都关了也不退出：靠托盘常驻
})

let quitting = false
app.on('before-quit', (event) => {
  globalShortcut.unregisterAll()
  stopWatcher()
  // 退出前必须让渲染层把内存里的最新正文落盘。
  // 防抖窗口（默认 800ms）内退出会让最后一笔输入丢失，且用户无从察觉。
  if (quitting) return
  const panel = winSvc?.getPanel?.()
  if (!panel || panel.isDestroyed()) return
  event.preventDefault()
  quitting = true
  void requestFlush(1500).finally(() => {
    app.quit()
  })
})

app.on('will-quit', () => {
  void aiSvc?.dispose()
})

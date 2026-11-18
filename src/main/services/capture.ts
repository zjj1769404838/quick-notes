/**
 * 快速捕捉窗服务 —— 零摩擦录入的宿主侧。
 *
 * 设计依据 docs/05-交互重构设计.md §3：
 *  - 480×260 DIP，居中于鼠标所在屏，置顶，无边框
 *  - 失焦**不销毁**，保留草稿（关窗不丢文本）
 *  - 关掉后草稿留在内存 + 主进程草稿文件，下次唤起恢复
 */
import { BrowserWindow, screen, app } from 'electron'
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { IPC } from '../../shared/ipc-channels.js'
import type { NoteService } from './notes.js'
import { bootLog } from './logger.js'

const W = 480
const H = 260
const MIN_W = 380
const MIN_H = 200

export interface CaptureDraft {
  name: string
  title: string
  body: string
}

export class CaptureService {
  private win: BrowserWindow | null = null
  private notes: NoteService
  private draftFile: string
  private draft: CaptureDraft | null = null
  private devUrl: string | null
  private __dirname: string

  constructor(notes: NoteService, dataDir: string, devUrl: string | null, dirname: string) {
    this.notes = notes
    this.draftFile = path.join(dataDir, 'capture-draft.json')
    this.devUrl = devUrl
    this.__dirname = dirname
  }

  /** 启动时读回上次未落盘的草稿 */
  async loadDraft(): Promise<void> {
    try {
      if (!existsSync(this.draftFile)) return
      const raw = await fs.readFile(this.draftFile, 'utf-8')
      const d = JSON.parse(raw) as CaptureDraft
      if (d && (d.body?.trim() || d.title?.trim())) this.draft = d
    } catch {
      this.draft = null
    }
  }

  /** 取未落盘草稿（供渲染层恢复） */
  pending(): CaptureDraft | null {
    return this.draft
  }

  private async persistDraft(d: CaptureDraft | null): Promise<void> {
    this.draft = d
    try {
      if (!d || (!d.body?.trim() && !d.title?.trim())) {
        await fs.rm(this.draftFile, { force: true })
        return
      }
      await fs.mkdir(path.dirname(this.draftFile), { recursive: true })
      await fs.writeFile(this.draftFile, JSON.stringify(d), 'utf-8')
    } catch (e) {
      bootLog('persistDraft failed: ' + ((e as Error)?.message ?? String(e)))
    }
  }

  /** 保存正文到笔记目录；文件名冲突自动加 -2 */
  async save(input: {
    relPath: string | null
    desiredName: string
    markdown: string
  }): Promise<{ relPath: string }> {
    // 已有文件 → 覆盖写
    if (input.relPath) {
      await this.notes.write(input.relPath, input.markdown, 'crlf')
      await this.persistDraft(null)
      return { relPath: input.relPath }
    }
    // 新文件 → 按 desiredName 命名，冲突加后缀
    const safe = this.sanitizeName(input.desiredName)
    let rel = `${safe}.md`
    let n = 2
    while (existsSync(path.join(this.notes.rootDir, rel))) {
      rel = `${safe}-${n}.md`
      n++
      if (n > 999) throw new Error('同名文件过多')
    }
    await this.notes.write(rel, input.markdown, 'crlf')
    await this.persistDraft(null)
    return { relPath: rel }
  }

  /** 重命名当前草稿对应的文件 */
  async rename(relPath: string, desiredName: string): Promise<{ relPath: string }> {
    const safe = this.sanitizeName(desiredName)
    const dir = path.dirname(relPath)
    const target = dir && dir !== '.' ? `${dir}/${safe}.md` : `${safe}.md`
    if (target === relPath) return { relPath }
    const r = await this.notes.rename(relPath, safe)
    return r
  }

  /** 清理文件名：去掉 Windows 非法字符与 .md 后缀 */
  private sanitizeName(raw: string): string {
    let s = (raw || '').trim()
    s = s.replace(/\.md$/i, '')
    s = s.replace(/[<>:"|?*\u0000-\u001f]/g, '')
    s = s.replace(/^\.+/, '').replace(/[. ]+$/, '')
    if (!s) {
      const d = new Date()
      const p = (n: number): string => String(n).padStart(2, '0')
      s = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
    }
    return s.slice(0, 120)
  }

  create(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win

    const cursor = screen.getCursorScreenPoint()
    const wa = screen.getDisplayNearestPoint(cursor).workArea
    const x = Math.round(wa.x + (wa.width - W) / 2)
    // 略偏上，符合「弹出来就能写」的视线落点
    const y = Math.round(wa.y + Math.max(40, (wa.height - H) / 2 - 60))

    const win = new BrowserWindow({
      width: W,
      height: H,
      minWidth: MIN_W,
      minHeight: MIN_H,
      x,
      y,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: true,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      hasShadow: true,
      webPreferences: {
        preload: path.join(this.__dirname, '../preload/index.cjs'),
        contextIsolation: true,
        sandbox: false,
        nodeIntegration: false,
        spellcheck: false,
        webSecurity: true
      }
    })

    win.setAlwaysOnTop(true, 'floating')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

    win.once('ready-to-show', () => {
      win.show()
      win.focus()
    })

    // 失焦：只隐藏，不销毁 —— 保留草稿与光标位置
    win.on('blur', () => {
      if (!win.isDestroyed()) win.hide()
    })

    win.on('closed', () => {
      this.win = null
    })

    const devUrl = this.devUrl
    if (devUrl) {
      void win.loadURL(`${devUrl}/capture.html`)
    } else {
      void win.loadFile(path.join(this.__dirname, '../renderer/capture.html'))
    }

    this.win = win
    return win
  }

  /** 唤起捕捉窗（已有则聚焦并显示） */
  show(): void {
    const win = this.win && !this.win.isDestroyed() ? this.win : this.create()
    // 每次唤起重新居中到鼠标所在屏
    const cursor = screen.getCursorScreenPoint()
    const wa = screen.getDisplayNearestPoint(cursor).workArea
    const b = win.getBounds()
    win.setBounds({
      x: Math.round(wa.x + (wa.width - b.width) / 2),
      y: Math.round(wa.y + Math.max(40, (wa.height - b.height) / 2 - 60)),
      width: b.width,
      height: b.height
    })
    win.show()
    win.focus()
    win.webContents.send(IPC.captureOpen)
  }

  /** 关闭捕捉窗（保留或不保留草稿由渲染层决定） */
  hide(): void {
    if (this.win && !this.win.isDestroyed()) this.win.hide()
  }

  isVisible(): boolean {
    return !!this.win && !this.win.isDestroyed() && this.win.isVisible()
  }

  getWindow(): BrowserWindow | null {
    return this.win
  }

  /** 应用退出前落盘草稿 */
  async dispose(): Promise<void> {
    if (this.win && !this.win.isDestroyed()) {
      try {
        this.win.webContents.send(IPC.evtFlushSave)
      } catch {
        /* 忽略 */
      }
    }
    void app
  }
}

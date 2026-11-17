/**
 * 窗口服务 —— 悬浮球窗口与笔记面板窗口的生命周期、几何、吸边、失焦收起。
 * 关键约束（03-架构设计文档.md §3.1）：
 *  - 球窗口：transparent + frame:false + alwaysOnTop + skipTaskbar
 *  - 面板窗口：无边框、可拖宽、失焦 300ms 收起、位置跟随球
 *  - 多显示器：全部 DIP 坐标，监听 display-metrics-changed
 */
import { BrowserWindow, screen, shell } from 'electron'
import path from 'node:path'
import { IPC } from '../../shared/ipc-channels.js'
import type { AppConfig } from '../../shared/types.js'
import { ConfigService } from './config.js'

// 主进程产物是 CJS（electron 仅支持 CJS 具名导入），__dirname 由 Node 直接提供

const BALL_SIZE = 56
const SNAP_THRESHOLD = 12
const EDGE_MARGIN = 8
const PANEL_MIN_WIDTH = 360
const PANEL_MAX_WIDTH = 1000
const PANEL_HEIGHT = 640
const PANEL_MIN_HEIGHT = 420
const HIDE_DELAY_MS = 300

export class WindowService {
  private ball: BrowserWindow | null = null
  private panel: BrowserWindow | null = null
  private hideTimer: NodeJS.Timeout | null = null
  private cfgSvc: ConfigService
  private devUrl: string | null

  constructor(cfgSvc: ConfigService, devUrl: string | null) {
    this.cfgSvc = cfgSvc
    this.devUrl = devUrl
  }

  private urlFor(page: 'ball' | 'panel', hash = ''): { url?: string; file?: string; hash: string } {
    if (this.devUrl) return { url: `${this.devUrl}/${page}.html`, hash }
    return { file: path.join(__dirname, `../renderer/${page}.html`), hash }
  }

  private load(win: BrowserWindow, page: 'ball' | 'panel', hash = ''): void {
    const t = this.urlFor(page, hash)
    if (t.url) {
      void win.loadURL(`${t.url}${hash ? `#${hash}` : ''}`)
    } else if (t.file) {
      void win.loadFile(t.file, hash ? { hash } : undefined)
    }
  }

  /** 计算球的初始位置：鼠标所在屏，右缘 8px，垂直居中（FR-1.1） */
  private initialBallPos(): { x: number; y: number } {
    const cfg = this.cfgSvc.current()
    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor)
    const wa = display.workArea

    if (cfg.ball.x !== null && cfg.ball.y !== null) {
      const saved = { x: cfg.ball.x, y: cfg.ball.y }
      // 校验是否落在任一屏幕工作区内，否则回落（FR-1.6 / 04 §11）
      const visible = screen.getAllDisplays().some((d) => {
        const a = d.workArea
        return saved.x >= a.x - BALL_SIZE / 2 && saved.x <= a.x + a.width - BALL_SIZE / 2 &&
          saved.y >= a.y - BALL_SIZE / 2 && saved.y <= a.y + a.height - BALL_SIZE / 2
      })
      if (visible) return saved
    }
    return {
      x: wa.x + wa.width - BALL_SIZE - EDGE_MARGIN,
      y: wa.y + Math.round((wa.height - BALL_SIZE) / 2)
    }
  }

  createBall(): BrowserWindow {
    if (this.ball && !this.ball.isDestroyed()) return this.ball
    const pos = this.initialBallPos()
    const cfg = this.cfgSvc.current()

    const win = new BrowserWindow({
      width: BALL_SIZE,
      height: BALL_SIZE,
      x: pos.x,
      y: pos.y,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      focusable: false,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.cjs'),
        contextIsolation: true,
        sandbox: false,
        nodeIntegration: false,
        spellcheck: false,
        webSecurity: true
      }
    })

    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    win.setOpacity(cfg.ball.opacity)

    win.once('ready-to-show', () => win.showInactive())
    win.on('closed', () => {
      this.ball = null
    })

    this.load(win, 'ball')
    this.ball = win
    return win
  }

  createPanel(): BrowserWindow {
    if (this.panel && !this.panel.isDestroyed()) return this.panel
    const cfg = this.cfgSvc.current()
    const bounds = this.panelTargetBounds(cfg)

    const win = new BrowserWindow({
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      frame: false,
      transparent: false,
      backgroundColor: '#FFFFFF',
      resizable: true,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      minWidth: PANEL_MIN_WIDTH,
      minHeight: PANEL_MIN_HEIGHT,
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.cjs'),
        contextIsolation: true,
        sandbox: false,
        nodeIntegration: false,
        spellcheck: false,
        webSecurity: true
      }
    })

    win.setAlwaysOnTop(true, 'floating')

    win.once('ready-to-show', () => {
      win.show()
      win.focus()
    })

    // 失焦 300ms 收起（FR-1.5）；由渲染层报告是否有未保存内容
    win.on('blur', () => {
      if (this.hideTimer) clearTimeout(this.hideTimer)
      this.hideTimer = setTimeout(() => {
        void this.maybeHidePanel()
      }, HIDE_DELAY_MS)
    })

    win.on('focus', () => {
      if (this.hideTimer) {
        clearTimeout(this.hideTimer)
        this.hideTimer = null
      }
    })

    win.on('resize', () => {
      if (!win.isDestroyed()) {
        const [w] = win.getSize()
        void this.cfgSvc.patch({ panel: { ...this.cfgSvc.current().panel, width: w } })
      }
    })

    win.on('closed', () => {
      this.panel = null
    })

    this.load(win, 'panel')
    this.panel = win
    return win
  }

  /** 面板位置：贴着球所在侧展开，垂直居中于球 */
  private panelTargetBounds(cfg: AppConfig): { x: number; y: number; width: number; height: number } {
    const cursor = screen.getCursorScreenPoint()
    const ballPos = this.ball && !this.ball.isDestroyed() ? this.ball.getPosition() : null
    const display = ballPos
      ? screen.getDisplayNearestPoint({ x: ballPos[0], y: ballPos[1] })
      : screen.getDisplayNearestPoint(cursor)
    const wa = display.workArea

    const width = Math.min(Math.max(cfg.panel.width, PANEL_MIN_WIDTH), PANEL_MAX_WIDTH)
    const height = Math.min(PANEL_HEIGHT, Math.max(wa.height - 64, PANEL_MIN_HEIGHT))

    let x: number
    let y: number
    if (ballPos) {
      const [bx, by] = ballPos
      const ballOnRight = bx + BALL_SIZE / 2 > wa.x + wa.width / 2
      x = ballOnRight ? bx - width - EDGE_MARGIN : bx + BALL_SIZE + EDGE_MARGIN
      // 面板贴边时向内收，保证完全可见
      x = Math.max(wa.x + EDGE_MARGIN, Math.min(x, wa.x + wa.width - width - EDGE_MARGIN))
      y = by + BALL_SIZE / 2 - height / 2
      y = Math.max(wa.y + EDGE_MARGIN, Math.min(y, wa.y + wa.height - height - EDGE_MARGIN))
    } else {
      x = wa.x + wa.width - width - EDGE_MARGIN
      y = wa.y + Math.round((wa.height - height) / 2)
    }
    return { x, y, width, height }
  }

  async showPanel(): Promise<void> {
    const win = this.panel && !this.panel.isDestroyed() ? this.panel : this.createPanel()
    const bounds = this.panelTargetBounds(this.cfgSvc.current())
    win.setBounds(bounds)
    if (!win.isVisible()) win.show()
    win.focus()
    this.ball?.webContents.send(IPC.evtPanelShown)
  }

  hidePanel(): void {
    if (!this.panel || this.panel.isDestroyed()) return
    this.panel.hide()
    this.ball?.webContents.send(IPC.evtPanelHidden)
  }

  togglePanel(): void {
    if (this.panel && !this.panel.isDestroyed() && this.panel.isVisible()) {
      this.hidePanel()
    } else {
      void this.showPanel()
    }
  }

  /** 由渲染层告知「有未保存内容」，此时失焦不收起而是保留并提示 */
  private panelHasUnsaved = false
  setPanelUnsaved(v: boolean): void {
    this.panelHasUnsaved = v
  }

  private async maybeHidePanel(): Promise<void> {
    if (!this.panel || this.panel.isDestroyed()) return
    if (this.panelHasUnsaved) {
      // 保留面板，通知渲染层显示「未保存」标记
      this.panel.webContents.send(IPC.evtToast, {
        level: 'warn',
        text: '有未保存的修改，已保留面板。按 Ctrl+S 立即保存。'
      })
      return
    }
    this.hidePanel()
  }

  /** 拖动结束后吸附到最近的屏幕边缘（FR-1.2） */
  snapBall(): void {
    if (!this.ball || this.ball.isDestroyed()) return
    const [x, y] = this.ball.getPosition()
    const display = screen.getDisplayNearestPoint({ x: x + BALL_SIZE / 2, y: y + BALL_SIZE / 2 })
    const wa = display.workArea
    let nx = x
    let ny = y

    const distLeft = Math.abs(x - wa.x)
    const distRight = Math.abs(wa.x + wa.width - (x + BALL_SIZE))
    if (distLeft < SNAP_THRESHOLD) nx = wa.x + EDGE_MARGIN
    else if (distRight < SNAP_THRESHOLD) nx = wa.x + wa.width - BALL_SIZE - EDGE_MARGIN

    const distTop = Math.abs(y - wa.y)
    const distBottom = Math.abs(wa.y + wa.height - (y + BALL_SIZE))
    if (distTop < SNAP_THRESHOLD) ny = wa.y + EDGE_MARGIN
    else if (distBottom < SNAP_THRESHOLD) ny = wa.y + wa.height - BALL_SIZE - EDGE_MARGIN

    // 保证不出工作区
    nx = Math.max(wa.x, Math.min(nx, wa.x + wa.width - BALL_SIZE))
    ny = Math.max(wa.y, Math.min(ny, wa.y + wa.height - BALL_SIZE))

    this.ball.setPosition(nx, ny)
    void this.cfgSvc.patch({ ball: { ...this.cfgSvc.current().ball, x: nx, y: ny } })
  }

  /** 屏幕几何变化（拔插显示器 / 改缩放）后修复球与面板位置 */
  handleDisplayChange(): void {
    if (this.ball && !this.ball.isDestroyed()) {
      const [x, y] = this.ball.getPosition()
      const inSome = screen.getAllDisplays().some((d) => {
        const a = d.workArea
        return x + BALL_SIZE > a.x && x < a.x + a.width && y + BALL_SIZE > a.y && y < a.y + a.height
      })
      if (!inSome) {
        const primary = screen.getPrimaryDisplay().workArea
        const nx = primary.x + primary.width - BALL_SIZE - EDGE_MARGIN
        const ny = primary.y + Math.round((primary.height - BALL_SIZE) / 2)
        this.ball.setPosition(nx, ny)
        void this.cfgSvc.patch({ ball: { ...this.cfgSvc.current().ball, x: nx, y: ny } })
      }
    }
    if (this.panel && !this.panel.isDestroyed() && this.panel.isVisible()) {
      this.panel.setBounds(this.panelTargetBounds(this.cfgSvc.current()))
    }
  }

  setBallOpacity(v: number): void {
    this.ball?.setOpacity(Math.max(0.3, Math.min(1, v)))
  }

  getBall(): BrowserWindow | null {
    return this.ball
  }

  getPanel(): BrowserWindow | null {
    return this.panel
  }

  isPanelVisible(): boolean {
    return !!this.panel && !this.panel.isDestroyed() && this.panel.isVisible()
  }

  openInExplorer(relPath: string, root: string): void {
    const abs = path.resolve(root, relPath)
    void shell.showItemInFolder(abs)
  }
}

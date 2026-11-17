/**
 * 启动日志 —— 记录关键启动阶段，便于排查"启动了但看不到窗口"这类问题。
 * 只记阶段名与状态，不记录笔记正文（NFR-4 / 04 §12）。
 */
import { app } from 'electron'
import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

function logFile(): string {
  const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
  const dir = path.join(base, 'QuickNotes', 'logs')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* 忽略 */
  }
  return path.join(dir, 'boot.log')
}

let ready = false

export function bootLog(msg: string): void {
  try {
    if (!ready) {
      ready = true
      appendFileSync(logFile(), `\n===== ${new Date().toISOString()} boot =====\n`)
    }
    appendFileSync(logFile(), `[${new Date().toISOString()}] ${msg}\n`)
  } catch {
    /* 日志失败不得影响启动 */
  }
  if (!app.isPackaged) console.log('[boot]', msg)
}

/**
 * Preload —— 通过 contextBridge 只暴露一事一接口的白名单 API。
 * 渲染层永远拿不到 ipcRenderer 本体，也拿不到 Node 的 fs。
 */
import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc-channels.js'
import type {
  AiCapability,
  AiRunRequest,
  AiStreamChunk,
  AppConfig,
  DirNode,
  IpcResult,
  ModelDownloadProgress,
  ModelId,
  ModelStatus,
  NoteContent,
  SearchResult,
  SystemInfo
} from '../shared/types.js'

function invoke<T>(channel: string, ...args: unknown[]): Promise<IpcResult<T>> {
  // 统一兜底：通道未注册或主进程异常时 invoke 会 reject，
  // 若直接抛回渲染层会让首个 useEffect 中断，界面永久卡在「载入中…」。
  return (ipcRenderer.invoke(channel, ...args) as Promise<IpcResult<T>>).catch((e: unknown) => ({
    ok: false,
    error: { code: "E_UNKNOWN", message: (e as Error)?.message ?? String(e) }
  }))
}

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  window: {
    ballSetPos: (x: number, y: number) => invoke<boolean>(IPC.ballSetPos, x, y),
    ballGetPos: () => invoke<[number, number]>(IPC.ballGetPos),
    ballSnap: () => invoke<boolean>(IPC.ballSnap),
    resetBall: () => invoke<boolean>('ball:reset'),
    panelShow: () => invoke<boolean>(IPC.panelShow),
    openMain: () => invoke<boolean>('panel:openMain'),
    newInMain: () => invoke<boolean>('note:newInMain'),
    panelHide: () => invoke<boolean>(IPC.panelHide),
    panelGetBounds: () => invoke<Electron.Rectangle | null>(IPC.panelGetBounds),
    panelResize: (width: number) => invoke<boolean>(IPC.panelResize, width),
    panelSetIgnoreMouse: (ignore: boolean) => invoke<boolean>(IPC.panelSetIgnoreMouse, ignore),
    setUnsaved: (v: boolean) => ipcRenderer.send('panel:setUnsaved', v)
  },
  notes: {
    listTree: () => invoke<DirNode>(IPC.noteListTree),
    read: (rel: string) => invoke<NoteContent>(IPC.noteRead, rel),
    write: (rel: string, body: string, eol: 'lf' | 'crlf', fmText?: string) =>
      invoke<{ mtimeMs: number }>(IPC.noteWrite, rel, body, eol, fmText),
    create: (body?: string) => invoke<{ relPath: string }>(IPC.noteCreate, body),
    rename: (rel: string, name: string) => invoke<{ relPath: string }>(IPC.noteRename, rel, name),
    delete: (rel: string) => invoke<boolean>(IPC.noteDelete, rel),
    reveal: (rel: string) => invoke<boolean>(IPC.noteRevealInExplorer, rel),
    recent: () => invoke<Array<{ path: string; openedAt: string }>>(IPC.noteRecent),
    listTrash: () =>
      invoke<Array<{ relPath: string; originalPath: string; deletedAt: string; size: number }>>(IPC.trashList),
    restoreFromTrash: (trashRel: string) => invoke<{ relPath: string }>(IPC.trashRestore, trashRel)
  },
  capture: {
    save: (input: { relPath: string | null; desiredName: string; markdown: string }) =>
      invoke<{ relPath: string }>(IPC.captureSave, input),
    rename: (relPath: string, desiredName: string) =>
      invoke<{ relPath: string }>(IPC.captureRename, relPath, desiredName),
    pending: () =>
      invoke<{ name: string; title: string; body: string } | null>(IPC.capturePending),
    close: (opts: { keepDraft: boolean }) => invoke<boolean>(IPC.captureClose, opts),
    onOpen: (cb: () => void) => on(IPC.captureOpen, cb)
  },
  root: {
    get: () => invoke<string>(IPC.rootGet),
    choose: () => invoke<string | null>(IPC.rootChoose),
    set: (dir: string) => invoke<string>(IPC.rootSet, dir)
  },
  search: {
    query: (q: string, limit?: number) => invoke<SearchResult>(IPC.searchQuery, q, limit),
    rebuild: () => invoke<{ docs: number; tookMs: number }>(IPC.indexRebuild),
    status: () => invoke<{ ready: boolean; docs: number; lastBuiltAt: number; building: boolean }>(IPC.indexStatus),
    tags: () => invoke<Array<{ tag: string; count: number }>>(IPC.tagsList),
    semanticStatus: () => invoke<{ available: boolean; ready: boolean; chunks: number; builtAt: number; building: boolean }>('semantic:status'),
    semanticRebuild: () => invoke<{ chunks: number; tookMs: number }>('semantic:rebuild'),
    semanticClear: () => invoke<boolean>('semantic:clear')
  },
  config: {
    get: () => invoke<AppConfig>(IPC.configGet),
    patch: (patch: Partial<AppConfig>) => invoke<AppConfig>(IPC.configPatch, patch)
  },
  ai: {
    capability: () => invoke<AiCapability>(IPC.aiCapability),
    models: () => invoke<ModelStatus[]>(IPC.aiModelsList),
    run: (req: AiRunRequest) => invoke<{ runId: string }>(IPC.aiRun, req),
    cancel: (runId: string) => ipcRenderer.send(IPC.aiCancel, runId),
    download: (id: ModelId) => invoke<boolean>(IPC.aiModelDownload, id),
    cancelDownload: (id: ModelId) => invoke<boolean>(IPC.aiModelCancel, id)
  },
  sys: {
    info: () => invoke<SystemInfo>(IPC.sysInfo),
    openExternal: (url: string) => invoke<boolean>(IPC.sysOpenExternal, url)
  },
  flush: {
    done: () => ipcRenderer.send(IPC.noteFlushDone)
  },
  clipboard: {
    saveImage: (noteRel: string) => invoke<string | null>('clipboard:saveImage', noteRel)
  },
  events: {
    onFileChanged: (cb: (p: { evt: string; relPath: string }) => void) => on(IPC.evtFileChanged, cb),
    onToast: (cb: (p: { level: 'info' | 'warn' | 'error'; text: string; route?: string; relPath?: string }) => void) =>
      on(IPC.evtToast, cb),
    onConfigChanged: (cb: (p: AppConfig) => void) => on(IPC.configChanged, cb),
    onAiStream: (cb: (p: AiStreamChunk) => void) => on(IPC.aiStream, cb),
    onModelProgress: (cb: (p: ModelDownloadProgress) => void) => on(IPC.aiModelProgress, cb),
    onRootChanged: (cb: (p: string) => void) => on(IPC.rootChanged, cb),
    onPanelShown: (cb: () => void) => on(IPC.evtPanelShown, cb),
    onPanelHidden: (cb: () => void) => on(IPC.evtPanelHidden, cb),
    onFlushSave: (cb: () => void) => on(IPC.evtFlushSave, cb)
  }
}

export type QnApi = typeof api

contextBridge.exposeInMainWorld('qn', api)

/**
 * IPC 通道名常量 —— 主进程与 preload 共用，避免字符串手误。
 * 命名规则：`<域>:<动作>`
 */

export const IPC = {
  /* 窗口 / 球控制 */
  ballShow: 'window:ballShow',
  ballHide: 'window:ballHide',
  ballSetPos: 'window:ballSetPos',
  ballGetPos: 'window:ballGetPos',
  panelShow: 'window:panelShow',
  panelHide: 'window:panelHide',
  panelResize: 'window:panelResize',
  panelGetBounds: 'window:panelGetBounds',
  panelSetIgnoreMouse: 'window:panelSetIgnoreMouse',

  /* 笔记 */
  noteListTree: 'note:listTree',
  noteRead: 'note:read',
  noteWrite: 'note:write',
  noteCreate: 'note:create',
  noteRename: 'note:rename',
  noteDelete: 'note:delete',
  noteRecent: 'note:recent',
  noteRevealInExplorer: 'note:reveal',

  /* 目录 */
  rootGet: 'root:get',
  rootChoose: 'root:choose',
  rootSet: 'root:set',
  rootChanged: 'root:changed',

  /* 搜索 / 索引 */
  searchQuery: 'search:query',
  indexRebuild: 'index:rebuild',
  indexStatus: 'index:status',
  tagsList: 'tags:list',

  /* 设置 */
  configGet: 'config:get',
  configPatch: 'config:patch',
  configChanged: 'config:changed',

  /* AI */
  aiCapability: 'ai:capability',
  aiRun: 'ai:run',
  aiCancel: 'ai:cancel',
  aiStream: 'ai:stream',
  aiModelDownload: 'ai:modelDownload',
  aiModelCancel: 'ai:modelCancel',
  aiModelProgress: 'ai:modelProgress',
  aiModelsList: 'ai:modelsList',

  /* 系统 */
  sysInfo: 'sys:info',
  sysOpenExternal: 'sys:openExternal',

  /* 由主进程主动推给渲染层的事件 */
  evtFileChanged: 'evt:fileChanged',
  evtToast: 'evt:toast',
  evtPanelShown: 'evt:panelShown',
  evtPanelHidden: 'evt:panelHidden'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

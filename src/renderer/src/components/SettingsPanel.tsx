/** 设置面板 —— 目录 / 主题 / 热键 / AI 门禁与模型 / 索引 / 关于 */
import React, { useEffect, useState } from 'react'
import type { AiCapability, AppConfig, ModelDownloadProgress, ModelStatus, SystemInfo } from '../../../shared/types.js'

interface Props {
  cfg: AppConfig
  onClose: () => void
  onChange: (patch: Partial<AppConfig>) => Promise<void>
  pushToast: (level: string, text: string) => void
  onTagClick: (tag: string) => void
}

export function SettingsPanel({ cfg, onClose, onChange, pushToast, onTagClick }: Props): React.JSX.Element {
  const [cap, setCap] = useState<AiCapability | null>(null)
  const [sys, setSys] = useState<SystemInfo | null>(null)
  const [models, setModels] = useState<ModelStatus[]>([])
  const [progress, setProgress] = useState<Record<string, ModelDownloadProgress>>({})
  const [tags, setTags] = useState<Array<{ tag: string; count: number }>>([])
  const [indexStat, setIndexStat] = useState<{ ready: boolean; docs: number; lastBuiltAt: number; building: boolean } | null>(null)

  useEffect(() => {
    void (async () => {
      const c = await window.qn.ai.capability()
      if (c.ok) setCap(c.data)
      const s = await window.qn.sys.info()
      if (s.ok) setSys(s.data)
      const m = await window.qn.ai.models()
      if (m.ok) setModels(m.data)
      const t = await window.qn.search.tags()
      if (t.ok) setTags(t.data)
      const i = await window.qn.search.status()
      if (i.ok) setIndexStat(i.data)
    })()
    return window.qn.events.onModelProgress((p) => {
      setProgress((prev) => ({ ...prev, [p.modelId]: p }))
      if (p.stage === 'done') {
        pushToast('info', '模型下载完成')
        void window.qn.ai.models().then((r) => r.ok && setModels(r.data))
      }
      if (p.stage === 'failed') {
        pushToast('error', `模型下载失败：${p.error?.message ?? '未知原因'}`)
      }
    })
  }, [pushToast])

  const gateOk = cap?.meetsGate ?? true

  return (
    <div className="search-overlay" style={{ inset: '44px 0 26px' }}>
      <div className="search-head">
        <span style={{ fontWeight: 600, fontSize: 14, alignSelf: 'center' }}>设置</span>
        <button className="btn ghost small" style={{ marginLeft: 'auto' }} onClick={onClose}>
          关闭
        </button>
      </div>
      <div className="settings">
        <h3>笔记</h3>
        <div className="setting-row">
          <div className="k">
            存放目录
            <small>切换目录只切换索引，不会移动或删除已有文件</small>
          </div>
          <div className="v">
            <span className="path-box" title={cfg.noteRoot}>
              {cfg.noteRoot}
            </span>
            <button
              className="btn ghost small"
              onClick={async () => {
                const res = await window.qn.root.choose()
                const dir = res.ok ? res.data : null
                if (!dir) return
                const r = await window.qn.root.set(dir)
                if (r.ok) {
                  pushToast('info', '目录已切换，正在重建索引…')
                  const i = await window.qn.search.status()
                  if (i.ok) setIndexStat(i.data)
                } else {
                  pushToast('error', `切换失败：${r.error.message}`)
                }
              }}
            >
              更改
            </button>
          </div>
        </div>
        <div className="setting-row">
          <div className="k">
            自动保存延迟
            <small>停止输入后多久写盘</small>
          </div>
          <div className="v">
            <select
              className="ctl"
              value={cfg.editor.autoSaveDelayMs}
              onChange={(e) => void onChange({ editor: { ...cfg.editor, autoSaveDelayMs: Number(e.target.value) } })}
            >
              <option value={300}>0.3 秒</option>
              <option value={800}>0.8 秒</option>
              <option value={1500}>1.5 秒</option>
              <option value={3000}>3 秒</option>
            </select>
          </div>
        </div>
        <div className="setting-row">
          <div className="k">主题</div>
          <div className="v">
            <select
              className="ctl"
              value={cfg.theme}
              onChange={(e) => void onChange({ theme: e.target.value as AppConfig['theme'] })}
            >
              <option value="system">跟随系统</option>
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </select>
          </div>
        </div>
        <div className="setting-row">
          <div className="k">字号</div>
          <div className="v">
            <input
              className="ctl"
              type="range"
              min={11}
              max={24}
              value={cfg.editor.fontSize}
              onChange={(e) => void onChange({ editor: { ...cfg.editor, fontSize: Number(e.target.value) } })}
            />
            <span>{cfg.editor.fontSize}px</span>
          </div>
        </div>

        <h3>系统</h3>
        <div className="setting-row">
          <div className="k">
            开机自启
            <small>启动后只显示悬浮球与托盘，不弹面板</small>
          </div>
          <div className="v">
            <button
              className="switch"
              data-on={cfg.autostart}
              onClick={() => void onChange({ autostart: !cfg.autostart })}
              aria-label="开机自启"
            />
          </div>
        </div>
        <div className="setting-row">
          <div className="k">
            全局热键
            <small>新建笔记 / 显示隐藏面板（被占用时请改这里）</small>
          </div>
          <div className="v">
            <input
              className="ctl"
              style={{ width: 110 }}
              value={cfg.hotkey.newNote}
              onChange={(e) => void onChange({ hotkey: { ...cfg.hotkey, newNote: e.target.value } })}
            />
            <input
              className="ctl"
              style={{ width: 120 }}
              value={cfg.hotkey.togglePanel}
              onChange={(e) => void onChange({ hotkey: { ...cfg.hotkey, togglePanel: e.target.value } })}
            />
          </div>
        </div>

        <h3>本地 AI</h3>
        {!gateOk && (
          <div className="gate-note" style={{ marginBottom: 12 }}>
            <strong>本机内存 {cap?.totalMemGb ?? '?'} GB，低于 8 GB，已禁用本地 AI。</strong>
            <br />
            原因是本地模型（最小 0.6B 量化版）加载后需要约 1.1 GB 额外内存，在内存不足的机器上会触发硬盘交换、让整台电脑变卡。
            <br />
            你的笔记功能完全不受影响。换一台 8 GB 以上的机器即可开启，或在设置里点「重新检测」。
            <div style={{ marginTop: 8 }}>
              <button
                className="btn ghost small"
                onClick={async () => {
                  const c = await window.qn.ai.capability()
                  if (c.ok) setCap(c.data)
                  pushToast('info', `当前可用内存 ${c.ok ? c.data.totalMemGb : '?'} GB`)
                }}
              >
                重新检测
              </button>
            </div>
          </div>
        )}
        <div className="setting-row">
          <div className="k">
            启用本地 AI
            <small>
              {sys?.isFullEdition ? '完整版：模型已内置，无需下载' : '精简版：首次启用需下载模型'}
            </small>
          </div>
          <div className="v">
            <button
              className="switch"
              data-on={cfg.ai.enabled}
              disabled={!gateOk}
              onClick={() => void onChange({ ai: { ...cfg.ai, enabled: !cfg.ai.enabled } })}
              aria-label="启用本地 AI"
            />
          </div>
        </div>
        <div className="setting-row">
          <div className="k">
            模型档位
            <small>
              0.6B 适合 8 GB 机器；1.5B 质量更好但需要 16 GB 以上
            </small>
          </div>
          <div className="v">
            <select
              className="ctl"
              value={cfg.ai.tier}
              disabled={!gateOk}
              onChange={(e) => void onChange({ ai: { ...cfg.ai, tier: e.target.value as AppConfig['ai']['tier'] } })}
            >
              <option value="0.6b">0.6B（约 378 MB）</option>
              <option value="1.5b" disabled={(cap?.totalMemGb ?? 0) < 16}>
                1.5B（约 940 MB，需 16 GB）
              </option>
            </select>
          </div>
        </div>
        <div className="setting-row">
          <div className="k">
            GPU 加速
            <small>默认关闭。仅 NVIDIA/AMD 独显且显存 ≥4 GB 才建议开启；核显开启可能崩溃</small>
          </div>
          <div className="v">
            <select
              className="ctl"
              value={cfg.ai.gpuPolicy}
              onChange={(e) =>
                void onChange({ ai: { ...cfg.ai, gpuPolicy: e.target.value as AppConfig['ai']['gpuPolicy'] } })
              }
            >
              <option value="off">关闭（推荐）</option>
              <option value="auto" disabled={!cap?.gpu?.usable}>
                自动 {cap?.gpu ? `（检测到 ${cap.gpu.vendor}）` : '（未检测到可用独显）'}
              </option>
            </select>
          </div>
        </div>

        {cfg.ai.enabled && (
          <>
            <h3>模型文件</h3>
            {models.map((m) => {
              const p = progress[m.modelId]
              const pct = p?.percent ?? (m.installed ? 100 : 0)
              return (
                <div key={m.modelId} className="setting-row">
                  <div className="k">
                    {labelOf(m.modelId)}
                    <small>
                      {m.installed
                        ? `已就绪 · ${(m.bytes / 1024 / 1024).toFixed(0)} MB`
                        : p && p.stage === 'downloading'
                          ? `下载中 ${pct}%（${(p.receivedBytes / 1024 / 1024).toFixed(0)} / ${(p.totalBytes / 1024 / 1024).toFixed(0)} MB）`
                          : p?.stage === 'verifying'
                            ? '校验中…'
                            : '未下载'}
                    </small>
                    {p && p.stage === 'downloading' && (
                      <div className="progress">
                        <i style={{ width: `${pct}%` }} />
                      </div>
                    )}
                  </div>
                  <div className="v">
                    {m.installed ? (
                      <span style={{ color: 'var(--ok)', fontSize: 12 }}>✓ 已就绪</span>
                    ) : p?.stage === 'downloading' ? (
                      <button className="btn ghost small" onClick={() => void window.qn.ai.cancelDownload(m.modelId)}>
                        取消
                      </button>
                    ) : (
                      <button className="btn small" onClick={() => void window.qn.ai.download(m.modelId)}>
                        下载
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </>
        )}

        <h3>索引与标签</h3>
        <div className="setting-row">
          <div className="k">
            全文索引
            <small>
              {indexStat
                ? `${indexStat.docs} 篇已索引${indexStat.building ? '（重建中…）' : ''}`
                : '加载中…'}
            </small>
          </div>
          <div className="v">
            <button
              className="btn ghost small"
              onClick={async () => {
                pushToast('info', '开始重建索引…')
                const r = await window.qn.search.rebuild()
                if (r.ok) {
                  pushToast('info', `索引完成：${r.data.docs} 篇，用时 ${r.data.tookMs} ms`)
                  const i = await window.qn.search.status()
                  if (i.ok) setIndexStat(i.data)
                } else {
                  pushToast('error', `重建失败：${r.error.message}`)
                }
              }}
            >
              重建
            </button>
          </div>
        </div>
        {tags.length > 0 && (
          <div className="tag-cloud" style={{ padding: '8px 0' }}>
            {tags.slice(0, 40).map((t) => (
              <button key={t.tag} className="tag-chip" onClick={() => onTagClick(t.tag)}>
                #{t.tag}
                <span className="count">{t.count}</span>
              </button>
            ))}
          </div>
        )}

        <h3>关于</h3>
        <div className="setting-row">
          <div className="k">
            随手笔记 · {sys?.isFullEdition ? '完整版' : '精简版'}
            <small>
              v{sys?.appVersion} · Electron {sys?.electronVersion} · {sys?.platform}/{sys?.arch}
              <br />
              本机内存 {sys?.totalMemGb} GB（可用 {sys?.freeMemGb} GB）
              <br />
              数据目录 {sys?.dataDir}
              <br />
              全部功能本地运行，不联网、不上传、不采集任何数据（仅在你主动下载模型时访问 ModelScope）。
            </small>
          </div>
        </div>
      </div>
    </div>
  )
}

function labelOf(id: string): string {
  if (id.startsWith('qwen3-0.6b')) return 'Qwen3-0.6B（润色/续写/标题摘要）'
  if (id.startsWith('qwen2.5-1.5b')) return 'Qwen2.5-1.5B（高质量档）'
  if (id.startsWith('nomic')) return 'nomic-embed（语义检索）'
  return id
}

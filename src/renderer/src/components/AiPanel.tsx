/** 本地 AI 面板 —— 润色 / 续写 / 标题 / 摘要，流式输出与中止 */
import React, { useEffect, useRef, useState } from 'react'
import type { AiStreamChunk, AppConfig } from '../../../shared/types.js'

interface Props {
  cfg: AppConfig
  body: string
  selection: () => string
  cursorBefore: () => string
  onApply: (text: string, mode: 'replace' | 'append') => void
  onClose: () => void
  pushToast: (level: string, text: string) => void
}

type Task = 'polish' | 'continue' | 'title' | 'summary'

const TASK_LABEL: Record<Task, string> = {
  polish: '润色选中',
  continue: '续写',
  title: '生成标题',
  summary: '生成摘要'
}

export function AiPanel({ cfg, body, selection, cursorBefore, onApply, onClose, pushToast }: Props): React.JSX.Element {
  const [task, setTask] = useState<Task>('polish')
  const [out, setOut] = useState('')
  const [running, setRunning] = useState(false)
  const runIdRef = useRef<string | null>(null)
  const lastSeq = useRef(0)

  useEffect(() => {
    return window.qn.events.onAiStream((p: AiStreamChunk) => {
      if (runIdRef.current && p.runId !== runIdRef.current) return
      if (p.seq < lastSeq.current) return // 丢弃过期分片
      lastSeq.current = p.seq
      if (p.error) {
        setRunning(false)
        pushToast('error', `AI 出错：${p.error.message}`)
        return
      }
      setOut((prev) => prev + p.delta)
      if (p.done) setRunning(false)
    })
  }, [pushToast])

  const start = async (): Promise<void> => {
    const sel = selection()
    if ((task === 'polish' || task === 'continue') && !sel && task === 'polish') {
      pushToast('warn', '先选中要润色的文字')
      return
    }
    setOut('')
    lastSeq.current = 0
    setRunning(true)
    const r = await window.qn.ai.run({
      task,
      text: task === 'polish' ? sel : body,
      contextBefore: task === 'continue' ? cursorBefore() : undefined
    })
    if (!r.ok) {
      setRunning(false)
      pushToast('error', r.error.code === 'E_MODEL_MISSING' ? '模型还没下载，请到设置里下载模型' : r.error.message)
      return
    }
    runIdRef.current = r.data.runId
  }

  const stop = (): void => {
    if (runIdRef.current) window.qn.ai.cancel(runIdRef.current)
    setRunning(false)
  }

  const gate = cfg.ai.enabled

  return (
    <div className="ai-pop">
      <div className="ai-pop-head">
        <span>本地 AI</span>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-meta)', fontWeight: 400 }}>
          {cfg.ai.tier === '1.5b' ? '1.5B' : '0.6B'} · 纯本地
        </span>
      </div>

      {!gate ? (
        <div className="ai-pop-body">
          <div className="gate-note">
            <strong>本地 AI 已关闭。</strong>
            <br />
            开启后会下载约 378 MB 的模型（一次性），之后全部在本机离线运行，不联网、不上传任何内容。
            <br />
            内存低于 8 GB 的机器不建议开启——会让整台电脑变卡。
            <div style={{ marginTop: 10 }}>
              <button className="btn ghost small" onClick={onClose}>
                去设置里开启
              </button>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 6, padding: '8px 12px 0', flexWrap: 'wrap' }}>
            {(Object.keys(TASK_LABEL) as Task[]).map((t) => (
              <button
                key={t}
                className="tab"
                data-active={task === t}
                onClick={() => setTask(t)}
                disabled={running}
              >
                {TASK_LABEL[t]}
              </button>
            ))}
          </div>

          <div className="ai-pop-body">
            {running && !out && <span style={{ color: 'var(--text-meta)' }}>生成中…</span>}
            {out || (!running && !out ? <span style={{ color: 'var(--text-meta)' }}>点上面任一功能开始生成。结果会显示在这里，可以先看再决定是否采用。</span> : null)}
          </div>

          <div className="ai-pop-foot">
            {running ? (
              <button className="btn ghost small" onClick={stop}>
                中止 (Esc)
              </button>
            ) : (
              <button className="btn small" onClick={() => void start()} disabled={running}>
                {out ? '重新生成' : '开始'}
              </button>
            )}
            <button
              className="btn ghost small"
              disabled={!out || running}
              onClick={() => {
                onApply(out, 'replace')
                pushToast('info', '已替换选中内容')
                setOut('')
              }}
            >
              替换原文
            </button>
            <button
              className="btn ghost small"
              disabled={!out || running}
              onClick={() => {
                onApply(out, 'append')
                pushToast('info', '已追加到文末')
                setOut('')
              }}
            >
              追加到文末
            </button>
            <button className="btn ghost small" onClick={onClose}>
              关闭
            </button>
          </div>
        </>
      )}
    </div>
  )
}

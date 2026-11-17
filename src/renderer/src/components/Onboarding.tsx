/** 首次启动引导 —— 选笔记目录（FR-5.1），未确认前不创建任何笔记 */
import React, { useEffect, useState } from 'react'

interface Props {
  onDone: (dir: string) => Promise<void>
}

export function Onboarding({ onDone }: Props): React.JSX.Element {
  const [dir, setDir] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.qn.root.get().then((r) => {
      if (r.ok) setDir(r.data)
    })
  }, [])

  return (
    <div className="panel">
      <div className="titlebar">
        <span className="brand">随手笔记 · 首次使用</span>
      </div>
      <div className="empty" style={{ gap: 16 }}>
        <h2>笔记存到哪里？</h2>
        <p>
          笔记会保存成普通的 <strong>.md</strong> 文件，放在你自己选的一个文件夹里。
          随时可以用记事本、VS Code 或其他编辑器打开和修改，不是数据库、不会锁死。
        </p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'center' }}>
          <span className="path-box" style={{ maxWidth: 320 }} title={dir}>
            {dir || '读取中…'}
          </span>
          <button
            className="btn ghost small"
            onClick={async () => {
              const res = await window.qn.root.choose()
              if (res.ok && res.data) setDir(res.data)
            }}
          >
            换个文件夹
          </button>
        </div>
        <button
          className="btn"
          disabled={!dir || busy}
          onClick={async () => {
            setBusy(true)
            try {
              await onDone(dir)
            } finally {
              setBusy(false)
            }
          }}
        >
          {busy ? '正在准备…' : '就用这个文件夹，开始使用'}
        </button>
        <p style={{ fontSize: 12, color: 'var(--text-meta)', maxWidth: 340 }}>
          全部功能都在本机运行，不联网、不上传、不采集任何数据。
        </p>
      </div>
    </div>
  )
}

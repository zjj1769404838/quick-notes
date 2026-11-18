/**
 * 内联确认/输入对话框 —— 替换原生 window.confirm / window.prompt。
 *
 * 为什么必须换（docs/05 §4 U1）：
 * 原生 confirm/prompt 会让面板失焦，而主进程在失焦 300ms 后收起面板，
 * 用户在弹窗点确认时，面板已经消失 —— 看起来像程序崩了。
 *
 * 这里用面板内渲染的浮层，全程保持窗口焦点。
 */
import React, { useEffect, useRef, useState } from 'react'

export interface ConfirmOptions {
  title: string
  detail?: string
  confirmText?: string
  cancelText?: string
  /** danger = 红色确认按钮（删除等破坏性操作） */
  tone?: 'normal' | 'danger'
}

export interface PromptOptions extends ConfirmOptions {
  defaultValue?: string
  placeholder?: string
}

interface Props {
  mode: 'confirm' | 'prompt'
  options: ConfirmOptions | PromptOptions
  onResolve: (value: string | boolean | null) => void
}

export function InlineDialog({ mode, options, onResolve }: Props): React.JSX.Element {
  const p = options as PromptOptions
  const [text, setText] = useState(p.defaultValue ?? '')
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (mode === 'prompt') {
      // 输入型：聚焦并全选，用户可直接覆盖
      requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      })
    }
  }, [mode])

  const ok = (): void => {
    onResolve(mode === 'prompt' ? text.trim() : true)
  }
  const cancel = (): void => {
    onResolve(mode === 'prompt' ? null : false)
  }

  return (
    <div
      className="dlg-mask"
      onMouseDown={(e) => {
        // 点遮罩取消，但点面板内不动
        if (e.target === e.currentTarget) cancel()
      }}
    >
      <div
        className="dlg"
        role="dialog"
        aria-modal="true"
        aria-label={options.title}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            cancel()
          } else if (e.key === 'Enter' && mode === 'prompt') {
            e.preventDefault()
            ok()
          }
        }}
      >
        <div className="dlg-title">{options.title}</div>
        {options.detail && <div className="dlg-detail">{options.detail}</div>}
        {mode === 'prompt' && (
          <input
            ref={inputRef}
            className="dlg-input"
            value={text}
            placeholder={p.placeholder ?? ''}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                ok()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                cancel()
              }
            }}
          />
        )}
        <div className="dlg-actions">
          <button className="btn ghost small" onClick={cancel}>
            {options.cancelText ?? '取消'}
          </button>
          <button
            className={'btn small' + (options.tone === 'danger' ? ' danger' : '')}
            onClick={ok}
            disabled={mode === 'prompt' && !text.trim()}
          >
            {options.confirmText ?? '确定'}
          </button>
        </div>
      </div>
    </div>
  )
}

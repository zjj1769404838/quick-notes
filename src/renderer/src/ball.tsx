/** 悬浮球渲染进程 —— 56x56 圆形球，支持拖动、悬停增亮、点击展开面板 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import './ball.css'

type BallState = 'idle' | 'hover' | 'press' | 'dragging'

function Ball(): React.JSX.Element {
  const [state, setState] = useState<BallState>('idle')
  const dragRef = useRef<{ startMouse: { x: number; y: number }; startWin: [number, number]; moved: boolean } | null>(
    null
  )

  const onMouseDown = useCallback(async (e: React.MouseEvent) => {
    if (e.button !== 0) return
    const res = await window.qn.window.ballGetPos()
    const winPos = res.ok ? res.data : ([0, 0] as [number, number])
    dragRef.current = {
      startMouse: { x: e.screenX, y: e.screenY },
      startWin: winPos,
      moved: false
    }
    setState('press')
  }, [])

  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      const d = dragRef.current
      if (!d) return
      const dx = e.screenX - d.startMouse.x
      const dy = e.screenY - d.startMouse.y
      if (!d.moved && Math.hypot(dx, dy) < 3) return
      d.moved = true
      setState('dragging')
      void window.qn.window.ballSetPos(d.startWin[0] + dx, d.startWin[1] + dy)
    }
    const onUp = (): void => {
      const d = dragRef.current
      dragRef.current = null
      if (!d) return
      if (!d.moved) {
        // 没移动 → 当作点击，展开面板
        void window.qn.window.panelShow()
        setState('hover')
      } else {
        // 拖动结束 → 由主进程执行吸边（把它吸附到最近的屏幕边缘）
        setState('idle')
        void window.qn.window.ballSnap()
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  // 右键菜单由主进程接管，这里不拦截
  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
  }, [])

  return (
    <div className="ball-wrap" data-state={state}>
      <button
        className="ball"
        title="随手笔记（左键展开，右键菜单，可拖动）"
        onMouseDown={onMouseDown}
        onMouseEnter={() => setState((s) => (s === 'idle' ? 'hover' : s))}
        onMouseLeave={() => setState((s) => (s === 'hover' || s === 'press' ? 'idle' : s))}
        onContextMenu={onContextMenu}
        aria-label="打开随手笔记"
      >
        <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
          <path
            d="M7 8h10M7 12h10M7 16h6"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            fill="none"
          />
        </svg>
      </button>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Ball />
  </React.StrictMode>
)

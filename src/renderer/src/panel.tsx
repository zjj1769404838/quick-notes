/** 主面板渲染进程 —— 目录树 / 编辑器 / 预览 / 搜索 / 标签 / AI / 设置 */
import React from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import './panel.css'
import { App } from './components/App'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

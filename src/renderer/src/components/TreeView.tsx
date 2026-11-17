/** 目录树 —— 折叠/展开、选中、重命名、删除、按标签过滤 */
import React, { useMemo, useState } from 'react'
import type { DirNode } from '../../../shared/types.js'

interface Props {
  node: DirNode
  selected: string | null
  tagFilter: string | null
  tagMap?: Map<string, string[]>
  onOpen: (relPath: string) => void
  onDelete: (relPath: string) => void
  onRename: (relPath: string, oldName: string) => void
}

export function TreeView({ node, selected, tagFilter, onOpen, onDelete, onRename }: Props): React.JSX.Element {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const toggle = (rel: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(rel)) next.delete(rel)
      else next.add(rel)
      return next
    })
  }

  const renderNode = (n: DirNode, depth: number): React.ReactNode => {
    if (n.type === 'file') {
      // 标签过滤时不隐藏文件（标签过滤在搜索面板做），这里保持完整树
      void tagFilter
      const isSel = selected === n.relPath
      return (
        <div
          key={n.relPath}
          className="tree-row"
          data-selected={isSel}
          style={{ paddingLeft: 8 + depth * 12 }}
          onClick={() => onOpen(n.relPath)}
          onDoubleClick={() => onRename(n.relPath, n.name.replace(/\.md$/i, ''))}
          title={n.relPath}
          role="treeitem"
          aria-selected={isSel}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onOpen(n.relPath)
            if (e.key === 'F2') onRename(n.relPath, n.name.replace(/\.md$/i, ''))
            if (e.key === 'Delete') onDelete(n.relPath)
          }}
        >
          <span className="label">{n.name}</span>
          <button
            className="del"
            title="移到回收站"
            onClick={(e) => {
              e.stopPropagation()
              onDelete(n.relPath)
            }}
          >
            ✕
          </button>
        </div>
      )
    }

    const isCollapsed = collapsed.has(n.relPath)
    const hasChildren = (n.children?.length ?? 0) > 0
    if (depth > 0 && !hasChildren) return null

    return (
      <div key={n.relPath || 'root'} role="group">
        {depth > 0 && (
          <div
            className="tree-row"
            style={{ paddingLeft: 8 + (depth - 1) * 12 }}
            onClick={() => toggle(n.relPath)}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') toggle(n.relPath)
            }}
          >
            <span className="caret">{isCollapsed ? '▸' : '▾'}</span>
            <span className="label">{n.name}</span>
          </div>
        )}
        {!isCollapsed &&
          (n.children ?? []).map((c) => renderNode(c, depth === 0 ? 0 : depth + 1))}
      </div>
    )
  }

  const content = useMemo(() => renderNode(node, 0), [node, selected, collapsed, tagFilter])

  return (
    <div role="tree" aria-label="笔记目录">
      {content}
    </div>
  )
}

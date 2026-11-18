import React, { useMemo, useState } from 'react'
import type { DirNode } from '../../../shared/types.js'

interface Props {
  node: DirNode
  selected: string | null
  tagFilter: string | null
  /** 当前标签命中的路径集合；null = 不过滤。用于让标签筛选真的生效（docs/05 §4 U2） */
  allowedPaths?: Set<string> | null
  onOpen: (relPath: string) => void
  onDelete: (relPath: string) => void
  onRename: (relPath: string, oldName: string) => void
}

export function TreeView({
  node,
  selected,
  tagFilter,
  allowedPaths,
  onOpen,
  onDelete,
  onRename
}: Props): React.JSX.Element {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const toggle = (rel: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(rel)) next.delete(rel)
      else next.add(rel)
      return next
    })
  }

  /** 过滤：保留命中文件，以及含有命中文件的目录 */
  const prune = (n: DirNode): DirNode | null => {
    if (n.type === 'file') {
      if (!allowedPaths) return n
      return allowedPaths.has(n.relPath) ? n : null
    }
    const kids: DirNode[] = []
    for (const c of n.children ?? []) {
      const p = prune(c)
      if (p) kids.push(p)
    }
    // 有过滤时，空目录不显示（避免一堆展开后还是空的目录）
    if (allowedPaths && kids.length === 0 && n.relPath !== '') return null
    return { ...n, children: kids }
  }

  const visible = useMemo(() => prune(node) ?? { ...node, children: [] }, [node, allowedPaths])

  const renderNode = (n: DirNode, depth: number): React.ReactNode => {
    if (n.type === 'file') {
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
          <span className="label">{n.name.replace(/\.md$/i, '')}</span>
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
    const children = n.children ?? []
    if (depth > 0 && children.length === 0) return null

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
        {!isCollapsed && children.map((c) => renderNode(c, depth === 0 ? 0 : depth + 1))}
      </div>
    )
  }

  // 依赖里带上回调与 filter，避免切笔记后仍按旧的闭包判定（原实现漏了）
  const content = useMemo(
    () => renderNode(visible, 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visible, selected, collapsed, tagFilter, allowedPaths, onOpen, onDelete, onRename]
  )

  const empty = allowedPaths && (visible.children?.length ?? 0) === 0

  return (
    <div role="tree" aria-label="笔记目录">
      {empty ? (
        <div className="tree-empty">{tagFilter ? '没有含该标签的笔记' : '这个目录还没有笔记'}</div>
      ) : (
        content
      )}
    </div>
  )
}

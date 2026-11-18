const fs = require('fs')
const p = 'src/renderer/src/components/App.tsx'
let s = fs.readFileSync(p, 'utf8')

// 1) 在 tagFilter 状态后加「按标签算出允许路径集合」的 memo
const anchor = "  // 冷启动不该回到空白：把最近打开的一篇摆在最显眼处（docs/05 §4 U3）"
const add = [
  '  // 标签过滤：原先 tagFilter 只是显示一个 chip，树完全没过滤（docs/05 §4 U2）',
  '  // 这里在索引里查出含该标签的路径集合，再交给树过滤。',
  '  const [tagPaths, setTagPaths] = useState<Set<string> | null>(null)',
  '  useEffect(() => {',
  '    if (!tagFilter) {',
  '      setTagPaths(null)',
  '      return',
  '    }',
  '    void (async () => {',
  '      const r = await window.qn.search.query(tagFilter, 500)',
  '      if (!r.ok) return',
  '      const set = new Set<string>()',
  '      for (const h of r.data.lexical) {',
  '        if (h.tags.some((t) => t.toLowerCase() === tagFilter.toLowerCase())) set.add(h.relPath)',
  '      }',
  '      setTagPaths(set)',
  '    })()',
  '  }, [tagFilter])',
  '',
  anchor
].join('\n')
s = s.replace(anchor, add)

// 2) 把 tagPaths 传给 TreeView（替换 tagFilter 传参）
s = s.replace('                  tagFilter={tagFilter}', '                  tagFilter={tagFilter}\n                  allowedPaths={tagPaths}')

// 3) 标签 chip 旁显示命中数
s = s.replace(
  `                <button className="tag-chip" data-active="true" onClick={() => setTagFilter(null)}>
                  #{tagFilter} ×
                </button>`,
  `                <button className="tag-chip" data-active="true" onClick={() => setTagFilter(null)}>
                  #{tagFilter}
                  {tagPaths ? ` · ${tagPaths.size} 篇` : ''} ×
                </button>`
)

fs.writeFileSync(p, s)
console.log('tagPaths:', s.includes('tagPaths'))
console.log('allowedPaths 已传:', s.includes('allowedPaths={tagPaths}'))

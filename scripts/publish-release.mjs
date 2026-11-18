/**
 * 用本地已加密的 GitHub PAT 建 Release 并上传 exe 资产。
 *
 * 铁律：
 *  - token 只在进程内存流转，绝不打印、不落盘、不写日志
 *  - 上传后必须独立读回接口核验资产存在与字节数
 *
 * 用法：node scripts/publish-release.mjs <tag> <version>
 */
import { createDecipheriv } from 'node:crypto'
import { readFileSync, statSync, createReadStream } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const REPO = 'zjj1769404838/quick-notes'
const API = 'https://api.github.com'

function die(msg) {
  console.error(`[fail-closed] ${msg}`)
  process.exit(1)
}

/** 按插件 vault.ts 同构逻辑解密 v1.<base64(iv|tag|ciphertext)> */
function revealSecret() {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const keyPath = join(dshHome, 'git-panel', 'key.bin')
  const statePath = join(dshHome, 'git-panel', 'state.json')

  let key
  try {
    key = readFileSync(keyPath)
  } catch {
    die(`读不到密钥文件：${keyPath}`)
  }
  if (key.length !== 32) die('密钥长度不是 32 字节')

  const state = JSON.parse(readFileSync(statePath, 'utf-8'))
  const acc = (state.accounts || []).find((a) => a && a.secret && String(a.secret).startsWith('v1.'))
  if (!acc) die('state.json 中没有可用的加密凭据')

  const raw = Buffer.from(String(acc.secret).slice(3), 'base64')
  const iv = raw.subarray(0, 12)
  const tag = raw.subarray(12, 28)
  const body = raw.subarray(28)
  const d = createDecipheriv('aes-256-gcm', key, iv)
  d.setAuthTag(tag)
  const token = Buffer.concat([d.update(body), d.final()]).toString('utf8')
  if (!token) die('解密结果为空')
  return token
}

async function gh(token, path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'quick-notes-release-script',
      ...(init.headers || {})
    }
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { status: res.status, ok: res.ok, json, text }
}

const tag = process.argv[2] || 'v0.1.0'
const version = process.argv[3] || '0.1.0'
const FILES = [
  { name: `QuickNotes-Lite-Setup-${version}-x64.exe`, path: `release-final/QuickNotes-Lite-Setup-${version}-x64.exe`, label: '精简版 · 安装包（不含模型）' },
  { name: `QuickNotes-Lite-Portable-${version}-x64.exe`, path: `release-final/QuickNotes-Lite-Portable-${version}-x64.exe`, label: '精简版 · 绿色版（不含模型）' },
  { name: `QuickNotes-Full-Setup-${version}-x64.exe`, path: `release-final/QuickNotes-Full-Setup-${version}-x64.exe`, label: '完整版 · 安装包（内置模型）' },
  { name: `QuickNotes-Full-Portable-${version}-x64.exe`, path: `release-final/QuickNotes-Full-Portable-${version}-x64.exe`, label: '完整版 · 绿色版（内置模型）' }
]

const token = revealSecret()
console.log('凭据已解密（长度 ' + token.length + '，不显示内容）')

// 1) 确认仓库可访问
const who = await gh(token, '/user')
if (!who.ok) die(`凭据无效或网络失败 HTTP ${who.status}`)
console.log('账号：' + (who.json?.login ?? '?'))

// 2) 建或复用 release
let rel = await gh(token, `/repos/${REPO}/releases/tags/${tag}`)
if (rel.status === 404) {
  const bodyText = [
    '## 随手笔记 QuickNotes ' + version,
    '',
    'Windows 桌面悬浮球 Markdown 速记工具。',
    '',
    '### 下载哪个？',
    '',
    '| 文件 | 说明 | 体积 |',
    '|------|------|------|',
    '| `QuickNotes-Lite-Setup-*` | 精简版安装包，首次用 AI 时按需下载模型 | ~152 MB |',
    '| `QuickNotes-Lite-Portable-*` | 精简版绿色版，拷走即用 | ~139 MB |',
    '| `QuickNotes-Full-Setup-*` | 完整版安装包，内置 Qwen3-0.6B + embedding，离线可用 AI | ~599 MB |',
    '| `QuickNotes-Full-Portable-*` | 完整版绿色版 | ~585 MB |',
    '',
    '### 已知限制',
    '',
    '- 无代码签名，安装时 Windows 会提示「未知发布者」，属正常现象。',
    '- 4GB 内存机器上 AI 按设计禁用（笔记功能不受影响）。',
    '- 详见仓库 README 的「尚未实现」表格。'
  ].join('\n')
  const created = await gh(token, `/repos/${REPO}/releases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: tag,
      target_commitish: 'main',
      name: `随手笔记 ${version}`,
      body: bodyText,
      draft: false,
      prerelease: false
    })
  })
  if (!created.ok) die(`创建 Release 失败 HTTP ${created.status}: ${created.text.slice(0, 300)}`)
  rel = created
  console.log('Release 已创建：' + rel.json.html_url)
} else if (rel.ok) {
  console.log('Release 已存在，复用：' + rel.json.html_url)
} else {
  die(`查询 Release 失败 HTTP ${rel.status}`)
}

const releaseId = rel.json.id

// 3) 上传资产（已存在同名则先删，避免 422）
const existing = await gh(token, `/repos/${REPO}/releases/${releaseId}/assets`)
const existsByName = new Map((existing.json || []).map((a) => [a.name, a]))

for (const f of FILES) {
  let size
  try {
    size = statSync(f.path).size
  } catch {
    die(`本地文件缺失：${f.path}`)
  }
  const prev = existsByName.get(f.name)
  if (prev) {
    console.log(`删除同名旧资产：${f.name}`)
    await gh(token, `/repos/${REPO}/releases/assets/${prev.id}`, { method: 'DELETE' })
  }
  console.log(`上传 ${f.name}（${(size / 1024 / 1024).toFixed(0)} MB）…`)
  const uploadUrl = `https://uploads.github.com/repos/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(f.name)}`
  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(size),
      'User-Agent': 'quick-notes-release-script'
    },
    body: createReadStream(f.path),
    duplex: 'half'
  })
  const txt = await res.text()
  if (!res.ok) die(`上传失败 ${f.name} HTTP ${res.status}: ${txt.slice(0, 300)}`)
  const up = JSON.parse(txt)
  if (up.size !== size) die(`${f.name} 服务端字节数 ${up.size} ≠ 本地 ${size}`)
  console.log(`  ✓ ${up.name}  ${up.size} bytes  state=${up.state}`)
}

// 4) 独立读回核验
const after = await gh(token, `/repos/${REPO}/releases/${releaseId}/assets`)
if (!after.ok) die('核验读取失败')
const names = new Set((after.json || []).map((a) => a.name))
for (const f of FILES) {
  if (!names.has(f.name)) die(`核验失败：${f.name} 不在资产列表中`)
}
console.log('\n=== 核验通过 ===')
for (const a of after.json || []) {
  console.log(`  ${a.name}  ${(a.size / 1024 / 1024).toFixed(0)} MB  downloads=${a.download_count}`)
}
console.log('\nRelease 页面：' + rel.json.html_url)

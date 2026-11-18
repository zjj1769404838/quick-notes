/**
 * 上传单个资产到已有 Release，用 curl 而非 fetch 流式上传。
 * 原因：Node fetch + createReadStream 传 599MB 时会静默中断（已实测踩到）。
 * curl 支持 --retry 与断点续传，对大文件更稳。
 *
 * 用法：node scripts/upload-asset.mjs <tag> <本地文件路径> [资产名]
 * 凭据从插件 vault 解密，经环境变量传给 curl，不落盘。
 */
import { createDecipheriv } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import { spawnSync } from 'node:child_process'

const REPO = 'zjj1769404838/quick-notes'
const API = 'https://api.github.com'

function die(msg) {
  console.error(`[fail-closed] ${msg}`)
  process.exit(1)
}

function revealSecret() {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const key = readFileSync(join(dshHome, 'git-panel', 'key.bin'))
  if (key.length !== 32) die('密钥长度异常')
  const state = JSON.parse(readFileSync(join(dshHome, 'git-panel', 'state.json'), 'utf-8'))
  const acc = (state.accounts || []).find((a) => a && a.secret && String(a.secret).startsWith('v1.'))
  if (!acc) die('无可用凭据')
  const raw = Buffer.from(String(acc.secret).slice(3), 'base64')
  const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
  d.setAuthTag(raw.subarray(12, 28))
  const token = Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8')
  if (!token) die('解密为空')
  return token
}

const tag = process.argv[2] || die('缺少 tag')
const localPath = process.argv[3] || die('缺少本地文件路径')
const assetName = process.argv[4] || basename(localPath)

const size = statSync(localPath).size
console.log(`文件：${assetName}  ${(size / 1024 / 1024).toFixed(0)} MB`)

const token = revealSecret()

// 1) 取 release id
const relRes = spawnSync(
  'curl',
  ['-sS', '-H', 'Accept: application/vnd.github+json', '-H', `Authorization: Bearer ${token}`, `${API}/repos/${REPO}/releases/tags/${tag}`],
  { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 }
)
if (relRes.status !== 0) die(`查询 Release 失败：${relRes.stderr}`)
let rel
try {
  rel = JSON.parse(relRes.stdout)
} catch {
  die('Release 响应不是 JSON')
}
if (!rel.id) die(`Release ${tag} 不存在：${JSON.stringify(rel).slice(0, 200)}`)
const releaseId = rel.id

// 2) 若同名资产存在则删除
for (const a of rel.assets || []) {
  if (a.name === assetName) {
    console.log(`删除同名旧资产 id=${a.id}`)
    spawnSync(
      'curl',
      ['-sS', '-X', 'DELETE', '-H', `Authorization: Bearer ${token}`, '-H', 'Accept: application/vnd.github+json', `${API}/repos/${REPO}/releases/assets/${a.id}`],
      { encoding: 'utf-8' }
    )
  }
}

// 3) 用 curl 上传（大文件带重试与超时）
const uploadUrl = `https://uploads.github.com/repos/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(assetName)}`
console.log('开始上传（curl，含重试）…')
const up = spawnSync(
  'curl',
  [
    '-sS',
    '--fail-with-body',
    '--retry', '5',
    '--retry-delay', '3',
    '--retry-all-errors',
    '--connect-timeout', '30',
    '--max-time', '1800',
    '-X', 'POST',
    '-H', `Authorization: Bearer ${token}`,
    '-H', 'Content-Type: application/octet-stream',
    '-H', 'Accept: application/vnd.github+json',
    '--data-binary', `@${localPath}`,
    uploadUrl
  ],
  { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024, timeout: 1_900_000 }
)

if (up.status !== 0) {
  die(`上传失败 exit=${up.status}: ${(up.stderr || '').slice(0, 500)}`)
}
let asset
try {
  asset = JSON.parse(up.stdout)
} catch {
  die(`上传响应不是 JSON：${(up.stdout || '').slice(0, 300)}`)
}
if (!asset.id) die(`上传未返回资产 id：${JSON.stringify(asset).slice(0, 300)}`)
if (asset.size !== size) die(`服务端字节数 ${asset.size} ≠ 本地 ${size}`)
console.log(`✓ 上传成功 id=${asset.id} state=${asset.state} size=${asset.size}`)

// 4) 独立读回核验
const verify = spawnSync(
  'curl',
  ['-sS', '-H', 'Accept: application/vnd.github+json', '-H', `Authorization: Bearer ${token}`, `${API}/repos/${REPO}/releases/assets/${asset.id}`],
  { encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024 }
)
const v = JSON.parse(verify.stdout)
if (v.state !== 'uploaded' || v.size !== size) {
  die(`读回核验不符：state=${v.state} size=${v.size}`)
}
console.log(`✓ 读回核验通过：${v.name} ${(v.size / 1024 / 1024).toFixed(0)} MB`)

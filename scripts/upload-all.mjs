/**
 * 一次进程内串行上传多个资产。
 *
 * 背景（实测）：本环境下单独起进程上传大文件，除第一次外常被中途终止，
 * 且后台 job 会误报 running。因此把所有上传放在同一个进程里顺序完成，
 * 并在每步后直接通过 API 读回该资产真实状态，不依赖进程退出码。
 *
 * 用法：node scripts/upload-all.mjs <tag> <name1>=<path1> [<name2>=<path2> ...]
 */
import { createDecipheriv } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
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
  const state = JSON.parse(readFileSync(join(dshHome, 'git-panel', 'state.json'), 'utf-8'))
  const acc = (state.accounts || []).find((a) => a && a.secret && String(a.secret).startsWith('v1.'))
  if (!acc) die('无可用凭据')
  const raw = Buffer.from(String(acc.secret).slice(3), 'base64')
  const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
  d.setAuthTag(raw.subarray(12, 28))
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8')
}

const token = revealSecret()
const tag = process.argv[2] || die('缺少 tag')
const pairs = process.argv.slice(3).map((s) => {
  const i = s.indexOf('=')
  if (i < 0) die(`参数格式应为 name=path，收到：${s}`)
  return { name: s.slice(0, i), path: s.slice(i + 1) }
})
if (pairs.length === 0) die('至少给一个 name=path')

function api(path, init = {}) {
  const r = spawnSync(
    'curl',
    [
      '-sS',
      '-H', 'Accept: application/vnd.github+json',
      '-H', `Authorization: Bearer ${token}`,
      ...(init.method && init.method !== 'GET' ? ['-X', init.method] : []),
      `${API}${path}`
    ],
    { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 }
  )
  try {
    return JSON.parse(r.stdout)
  } catch {
    return null
  }
}

// 取 release
const rel = api(`/repos/${REPO}/releases/tags/${tag}`)
if (!rel || !rel.id) die(`Release ${tag} 不存在`)
const releaseId = rel.id

function assetByName(name) {
  const list = api(`/repos/${REPO}/releases/${releaseId}/assets`)
  return (list || []).find((a) => a.name === name) || null
}

let uploaded = 0
for (const { name, path } of pairs) {
  const size = statSync(path).size
  const already = assetByName(name)
  if (already && already.state === 'uploaded' && already.size === size) {
    console.log(`跳过（已存在且完整）：${name}`)
    uploaded++
    continue
  }
  if (already) {
    console.log(`删除不完整旧资产：${name} state=${already.state} size=${already.size}`)
    spawnSync('curl', ['-sS', '-X', 'DELETE', '-H', `Authorization: Bearer ${token}`, '-H', 'Accept: application/vnd.github+json', `${API}/repos/${REPO}/releases/assets/${already.id}`], { encoding: 'utf-8' })
  }
  console.log(`上传 ${name}  ${(size / 1024 / 1024).toFixed(0)} MB …`)
  const up = spawnSync(
    'curl',
    [
      '-sS', '--fail-with-body',
      '--retry', '5', '--retry-delay', '3', '--retry-all-errors',
      '--connect-timeout', '30', '--max-time', '2700',
      '-X', 'POST',
      '-H', `Authorization: Bearer ${token}`,
      '-H', 'Content-Type: application/octet-stream',
      '-H', 'Accept: application/vnd.github+json',
      '--data-binary', `@${path}`,
      `https://uploads.github.com/repos/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`
    ],
    { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024, timeout: 2_760_000 }
  )
  // 不信任 curl 的 stdout，直接读回真实状态
  const chk = assetByName(name)
  if (chk && chk.state === 'uploaded' && chk.size === size) {
    console.log(`  ✓ ${name}  ${(chk.size / 1024 / 1024).toFixed(0)} MB state=uploaded`)
    uploaded++
  } else {
    const st = chk ? `state=${chk.state} size=${chk.size}` : '资产不存在'
    console.error(`  ✗ ${name} 失败（${st}）curl_exit=${up.status}`)
  }
}

console.log(`\n完成 ${uploaded}/${pairs.length}`)
process.exit(uploaded === pairs.length ? 0 : 1)

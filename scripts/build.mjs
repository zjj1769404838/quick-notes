/**
 * 打包入口 —— 按版本决定是否把模型打进安装包。
 *
 * 为什么需要脚本：electron-builder 的 config 是静态 YAML，
 * 无法按环境变量条件性地包含 extraResources。精简版误把 459MB 模型打进去过，
 * 所以这里改成「生成一份临时 config」再调用 builder，从机制上杜绝该缺陷。
 *
 * 用法：node scripts/build.mjs <lite|full>
 */
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const BASE = join(ROOT, 'electron-builder.yml')
const TMP = join(ROOT, '.electron-builder.generated.yml')

const edition = (process.argv[2] || 'lite').toLowerCase()
if (!['lite', 'full'].includes(edition)) {
  console.error(`未知版本：${edition}（只支持 lite / full）`)
  process.exit(1)
}

function die(msg) {
  console.error(`\n[fail-closed] ${msg}`)
  process.exit(1)
}

let cfg = readFileSync(BASE, 'utf-8')

if (edition === 'full') {
  // 完整版：确认模型与 lock 就位，缺一即失败（不产出半成品包）
  const lockPath = join(ROOT, 'resources', 'models', 'models.lock.json')
  if (!existsSync(lockPath)) die('缺少 resources/models/models.lock.json，请先运行 node scripts/fetch-models.mjs')

  const lock = JSON.parse(readFileSync(lockPath, 'utf-8'))
  const need = ['qwen3-0.6b-q4km', 'nomic-embed-v15-q4km']
  for (const id of need) {
    const rec = lock[id]
    if (!rec) die(`lock 中缺少 ${id}，请重新运行 fetch-models.mjs`)
    if (!rec.verified) die(`${id} 未经官方 sha256 校验，拒绝打入安装包`)
    const file = join(ROOT, 'resources', 'models', id, rec.file)
    if (!existsSync(file)) die(`模型文件不存在：${file}`)
    const size = statSync(file).size
    if (size !== rec.size) die(`${id} 字节数 ${size} ≠ lock 记录 ${rec.size}`)
  }

  // 追加 extraResources（基础 yml 里没有，避免静态配置误打入精简版）
  cfg += `
extraResources:
  - from: resources/models
    to: models
    filter:
      - '**/*.gguf'
      - 'models.lock.json'
`
  console.log('[build] 完整版：已注入 extraResources（含模型）')
} else {
  console.log('[build] 精简版：不包含任何模型文件')
}

writeFileSync(TMP, cfg, 'utf-8')

const env = { ...process.env, QN_EDITION: edition }
delete env.ELECTRON_RUN_AS_NODE
const args = ['electron-builder', '--win', '--config', TMP]
const r = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, {
  cwd: ROOT,
  stdio: 'inherit',
  env,
  shell: process.platform === 'win32'
})

try {
  const { unlinkSync } = await import('node:fs')
  unlinkSync(TMP)
} catch {
  /* 忽略 */
}

process.exit(r.status ?? 1)

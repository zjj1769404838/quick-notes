/**
 * 模型获取脚本 —— 构建完整版安装包前调用。
 *
 * 职责（03/04 的 fail-closed 约定）：
 *  1. 从 ModelScope 的 repo/files API 读取官方 Sha256
 *  2. 下载 gguf 到 resources/models/<modelId>/
 *  3. 校验字节数与 sha256
 *  4. 写入 resources/models/models.lock.json
 *
 * 任一环节不符即退出码非 0，禁止产出"看起来成功"的包。
 *
 * 用法：
 *   node scripts/fetch-models.mjs             # 下载 0.6B + embedding（完整版所需）
 *   node scripts/fetch-models.mjs --only=chat # 只下聊天模型
 */
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const MODELS_DIR = join(ROOT, 'resources', 'models')
const LOCK_PATH = join(MODELS_DIR, 'models.lock.json')

/** 完整版随包分发的模型（精简版不需要任何模型） */
const BUNDLED = [
  {
    id: 'qwen3-0.6b-q4km',
    repo: 'unsloth/Qwen3-0.6B-GGUF',
    file: 'Qwen3-0.6B-Q4_K_M.gguf',
    bytes: 396705472
  },
  {
    id: 'nomic-embed-v15-q4km',
    repo: 'nomic-ai/nomic-embed-text-v1.5-GGUF',
    file: 'nomic-embed-text-v1.5.Q4_K_M.gguf',
    // 实测 ModelScope 官方字节数（2026-11-17），非估算
    bytes: 84106624
  }
]

const ALLOWED_HOSTS = ['modelscope.cn', 'www.modelscope.cn']
const CHUNK_REPORT = 64 * 1024 * 1024

const argOnly = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1]
const wanted = argOnly === 'chat' ? ['qwen3-0.6b-q4km'] : BUNDLED.map((m) => m.id)

function die(msg) {
  console.error(`\n[fail-closed] ${msg}`)
  process.exit(1)
}

function assertHost(url) {
  const h = new URL(url).hostname
  if (!ALLOWED_HOSTS.includes(h)) die(`域名不在白名单：${h}`)
}

/** 查询 ModelScope 官方 sha256 */
async function fetchOfficialSha256(repo, file) {
  // 该接口返回 Data.Files 数组（目录清单），需按文件名匹配出目标条目
  const url = `https://www.modelscope.cn/api/v1/models/${repo}/repo/files?Revision=master&Recursive=true`
  assertHost(url)
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) return { sha256: null, size: null, reason: `HTTP ${res.status}` }
  const json = await res.json()
  const files = json?.Data?.Files ?? json?.Files
  if (!Array.isArray(files)) return { sha256: null, size: null, reason: 'API 返回结构不含 Files 数组' }
  // 精确匹配文件名（Path 可能是 name 或含子目录）
  const hit = files.find((f) => {
    const name = String(f?.Name ?? '')
    const p = String(f?.Path ?? '')
    return name === file || p === file || p.endsWith(`/${file}`)
  })
  if (!hit) return { sha256: null, size: null, reason: `清单中未找到 ${file}` }
  const sha = hit.Sha256 ?? hit.sha256 ?? null
  const size = hit.Size ?? hit.size ?? null
  return {
    sha256: sha ? String(sha).toLowerCase() : null,
    size: typeof size === 'number' ? size : null,
    reason: sha ? null : '该条目未返回 Sha256 字段'
  }
}

async function download(url, dest, expectedBytes) {
  assertHost(url)
  const tmp = `${dest}.part`
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) die(`下载失败 HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length') ?? 0)
  if (expectedBytes && total && total !== expectedBytes) {
    die(`服务器声明字节数 ${total} 与预期 ${expectedBytes} 不符（可能已换版本，请更新脚本常量）`)
  }
  let got = 0
  let lastReport = 0
  const body = Readable.fromWeb(res.body)
  body.on('data', (c) => {
    got += c.length
    if (got - lastReport >= CHUNK_REPORT) {
      lastReport = got
      const pct = total ? ((got / total) * 100).toFixed(1) : '?'
      process.stdout.write(`\r  ${(got / 1024 / 1024).toFixed(0)} MB (${pct}%)`)
    }
  })
  await pipeline(body, createWriteStream(tmp))
  process.stdout.write('\r')
  return { tmp, got, total }
}

function sha256Of(file) {
  const h = createHash('sha256')
  h.update(readFileSync(file))
  return h.digest('hex')
}

async function main() {
  console.log('=== 随手笔记 · 模型获取（完整版） ===\n')
  mkdirSync(MODELS_DIR, { recursive: true })

  // 已有 lock 时读取，保留未重新下载的条目
  const lock = existsSync(LOCK_PATH) ? JSON.parse(readFileSync(LOCK_PATH, 'utf-8')) : {}
  let ok = 0
  let skipped = 0

  for (const spec of BUNDLED) {
    if (!wanted.includes(spec.id)) continue
    const dir = join(MODELS_DIR, spec.id)
    const dest = join(dir, spec.file)
    console.log(`[${spec.id}] ${spec.repo}`)

    // 1) 官方哈希
    const meta = await fetchOfficialSha256(spec.repo, spec.file)
    if (meta.sha256) {
      console.log(`  官方 sha256: ${meta.sha256.slice(0, 16)}…`)
    } else {
      console.log(`  ⚠ 无法取得官方 sha256（${meta.reason}），将做字节数校验`)
    }

    mkdirSync(dir, { recursive: true })

    // 2) 已存在则校验后跳过
    if (existsSync(dest)) {
      const size = statSync(dest).size
      const actual = sha256Of(dest)
      const sizeOk = spec.bytes ? size === spec.bytes : size > 1024 * 1024
      const hashOk = meta.sha256 ? actual === meta.sha256 : true
      if (sizeOk && hashOk) {
        console.log(`  ✓ 已存在且校验通过（${(size / 1024 / 1024).toFixed(0)} MB），跳过下载`)
        lock[spec.id] = { repo: spec.repo, file: spec.file, size, sha256: actual, verified: !!meta.sha256 }
        skipped++
        continue
      }
      console.log(`  ✗ 已存在但校验不通过（size=${size} hash=${actual.slice(0, 12)}），重新下载`)
      rmSync(dest, { force: true })
    }

    // 3) 下载
    const url = `https://www.modelscope.cn/api/v1/models/${spec.repo}/repo?Revision=master&FilePath=${encodeURIComponent(spec.file)}`
    const { tmp, got } = await download(url, dest, spec.bytes)
    if (spec.bytes && got !== spec.bytes) die(`${spec.id} 下载字节数 ${got} ≠ 预期 ${spec.bytes}`)
    if (got < 1024 * 1024) die(`${spec.id} 下载内容过小（${got} B），疑似错误页`)

    // 4) 校验
    const actual = sha256Of(tmp)
    if (meta.sha256 && actual !== meta.sha256) {
      rmSync(tmp, { force: true })
      die(`${spec.id} sha256 不匹配：期望 ${meta.sha256}，实际 ${actual}`)
    }
    const { renameSync } = await import('node:fs')
    renameSync(tmp, dest)
    console.log(`  ✓ 完成 ${(got / 1024 / 1024).toFixed(0)} MB，sha256=${actual.slice(0, 16)}…`)
    lock[spec.id] = { repo: spec.repo, file: spec.file, size: got, sha256: actual, verified: !!meta.sha256 }
    ok++
  }

  // 5) 写 lock —— 这是运行期校验的唯一依据
  writeFileSync(LOCK_PATH, JSON.stringify(lock, null, 2), 'utf-8')
  console.log(`\nlock 已写入：${LOCK_PATH}`)
  console.log(`新下载 ${ok} 个，跳过 ${skipped} 个`)
  console.log('\n下一步：npm run dist:full')
}

main().catch((e) => die(e?.stack ?? String(e)))

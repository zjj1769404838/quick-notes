// 用 git 插件自己的 vault 解密已存 PAT，通过 GitHub API 建 Release 并上传资产。
// 铁律：token 仅在进程内存流转，不打印、不落盘、不写日志。
import { readFileSync, statSync, createReadStream } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire('D:/my-projects/plugins/dsh-git-panel/')
const { open } = require('D:/my-projects/plugins/dsh-git-panel/lib/index.js').vault ?? {}

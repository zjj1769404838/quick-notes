# 随手笔记 QuickNotes

一款 Windows 桌面端的**悬浮球 Markdown 速记工具**。点一下球就是一个能直接写 Markdown 的小面板，笔记存成**纯 `.md` 文件**放在你自己选的目录里——不锁进数据库，随时能用任何编辑器打开。

自带**完全离线的本地 AI**（润色 / 续写 / 生成标题摘要 / 语义检索），并且按硬件分档：配置不够就自动关闭，绝不把机器拖卡。

## 特性

**悬浮球**
- 桌面常驻、可拖动、吸边、半透明、失焦收起、记住位置
- 托盘图标兜底（新建 / 显示隐藏 / 打开目录 / 设置 / 退出）
- 全局热键 `Ctrl+Alt+N` 新建

**编辑器**
- 源码编辑 + 实时预览，CodeMirror 6
- 自适应布局：默认 480px 单栏 → 拖宽到 520–900 上下分栏 → 超 900 左右分栏
- 预览防抖按实测渲染耗时自适应（120ms 目标，慢机器自动放宽）

**格式智能提示**
- 回车自动续写 `- ` / `1. ` / `- [ ] ` / `> `，有序列表序号递增
- `` ``` `` 回车自动补全围栏，光标落中间
- 符号自动配对 `**` `_` `` ` `` `[` `(`
- 斜杠命令：行首或空格后输入 `/`，13 个命令（`/h1` `/todo` `/table` `/code` `/date` …）
- 表格内 Tab / Shift+Tab 跳单元格
- 标题跳级、未闭合代码块、空链接的行内提示
- `Ctrl+B` / `Ctrl+I` / `Ctrl+K` / `Ctrl+Shift+K`
- 粘贴图片自动存 `assets/` 并插入链接
- 字数统计、大纲面板

**笔记管理**
- 新建 / 自动保存 / 重命名 / 删除到 `.trash`（不进回收站，可找回）
- 目录树、最近打开、全文检索（MiniSearch + `Intl.Segmenter` 中文分词）
- 标签：frontmatter `tags:` + 正文 `#tag` 双通道
- 切换目录只切索引，**不移动任何文件**

**本地 AI（可完全关闭）**
- 润色选中 / 续写 / 生成标题 / 生成摘要 / 语义检索
- 内存硬门禁：<8GB 默认禁用并置灰说明；8GB 用 0.6B；16GB+ 可选 1.5B
- GPU 默认关闭，仅 NVIDIA/AMD 独立显卡且显存 ≥4GB 才尝试，8 秒超时自动回滚 CPU
- 模型不随精简版发布，首次启用时按需下载（ModelScope，带 sha256 校验）

## 隐私

**默认零联网。** 唯一的出网点是「你主动点下载模型」，仅访问 `modelscope.cn` / `hf-mirror.com` 白名单域名。不采集遥测、不上报崩溃、不检查更新、不加载任何 CDN 资源。所有笔记、索引、配置都在本机磁盘。

## 技术栈

| 部分 | 选型 |
|------|------|
| 运行时 | Electron 45.3.3 |
| 构建 | electron-vite 6 + Vite 7.3.8 |
| UI | React 19.3.1 + TypeScript 5.9.3 |
| 编辑器 | CodeMirror 6.43.15 + @codemirror/lang-markdown |
| 渲染 | markdown-it 15.0.3 + DOMPurify 3.4.18 |
| 检索 | MiniSearch 7.2.0 + Intl.Segmenter |
| 本地推理 | node-llama-cpp 3.22.3（预编译二进制） |
| 打包 | electron-builder 26.18.0 |

## 开发

```bash
npm install
npm run dev          # 开发模式
npm run typecheck    # 类型检查（主进程 + 渲染层）
npm run build        # 构建
```

注意：本项目主进程以 **CJS** 输出（`out/main/index.cjs`）。Electron 是 CJS 模块，ESM 具名导入会在运行时报 `does not provide an export named 'BrowserWindow'`。

## 打包

```bash
# 精简版（不含模型，约 152MB 安装包 / 139MB 绿色版）
npm run dist:lite

# 完整版（内置 0.6B + embedding 模型，先拉模型）
node scripts/fetch-models.mjs
npm run dist:full
```

产物在 `release/`：
- `QuickNotes-Setup-<version>-x64.exe` — NSIS 安装包（用户级，免 UAC）
- `QuickNotes-Portable-<version>-x64.exe` — 绿色免安装版

### 已知限制

- **无代码签名**：安装时会触发 Windows SmartScreen「未知发布者」提示，无技术手段绕过。
- 4GB 内存机器上 AI 按设计禁用，笔记功能不受影响。
- AI 推理当前为「一次性生成 + 分片回放」，接口已按流式设计（含 seq 单调与中止语义）。
- 语义检索需先下载 embedding 模型并在设置里手动建立一次索引。

## 数据位置

| 内容 | 路径 |
|------|------|
| 笔记 | 用户指定目录（默认 `%USERPROFILE%\Documents\QuickNotes`） |
| 回收站 | `<笔记目录>\.trash\` |
| 配置 / 全文索引 / 日志 | `%APPDATA%\QuickNotes\` |
| 模型 | `%LOCALAPPDATA%\QuickNotes\models\` |

模型放 Local 而非 Roaming：域环境会把 Roaming 同步到服务器，1.3GB 模型会拖垮登录。

## 文档

设计过程完整留档在 [`docs/`](docs/)：
- [01 需求文档](docs/01-需求文档.md) — FR-1~FR-9 + NFR + 风险
- [02 UI-UX 设计](docs/02-UI-UX设计文档.md) — 设计令牌、悬浮球状态机、四宽度线框、文案表
- [03 架构设计](docs/03-架构设计文档.md) — 进程模型、IPC 契约、AI 子系统、网络边界
- [04 数据模型](docs/04-数据模型文档.md) — 存储分层、frontmatter、索引、向量、config schema
- [评审报告](docs/review/设计文档评审-20261117-2255.md) — 交叉一致性评审 + 实现阶段缺陷回写

## 许可

MIT

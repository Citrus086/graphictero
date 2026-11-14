<p align="center">
  <img src="build/icon.svg" width="128" height="128" alt="Graphictero icon">
</p>

<h1 align="center">Graphictero</h1>

<p align="center">个人论文关系图谱 macOS 应用 · A personal paper-relationship graph app for macOS</p>

<p align="center"><a href="#english">English</a></p>

---

## 简介

Graphictero 是我为自己读论文做的一个小工具。Zotero 擅长「存」论文，但很难表达「这篇和那篇是什么关系」。Graphictero 把论文放到一张图上，用 AI 为论文之间生成关系（类型 + 一句可编辑的自然语言陈述），帮助理清一条研究线的发展脉络，比如写综述或整理阅读笔记的时候。

它是单用户、本地优先的桌面应用：论文库、PDF 和图谱都保存在本机数据目录里。项目还很早期，难免有粗糙的地方，欢迎反馈。

> TODO：截图待补充。

## 功能

- **论文库与导入**：有自己的论文库，从 Zotero 单向导入（可按分类整体导入，也可逐篇勾选），不会写回 Zotero。缺 PDF 时可以按设置的来源（arXiv、Unpaywall 等开放获取来源、自定义模板）补齐，也可以手动拖入 PDF。
- **关系图谱**：可建多个图谱；画布上自由拖拽论文节点，或一键「整理」自动布局。AI 生成的关系直接上图，可编辑、让 AI 重写或删除。
- **图谱降噪**：关系多时，悬停或选中一篇论文会高亮它的直接邻域并淡化其余部分；可按关系类型筛选（带每类计数和重置）；右键「聚焦此论文」或选中后按 `F` 进入聚焦模式（1 跳 / 2 跳），`Esc` 退出并恢复视口。
- **PDF 解析**：用 [MinerU](https://github.com/opendatalab/MinerU) 在本机解析 PDF（只监听 127.0.0.1），提取正文、图表和公式，供详情页和对话使用。
- **论文详情页**：解析完成后自动生成并缓存，可手动重新生成。除文字外，可以包含论文原图、ECharts 图表、Mermaid 图，以及「交互讲解」：用滑条、数字框、下拉框、开关等控件调整公式参数，曲线和结果在本地实时计算（不执行模型生成的代码）。
- **内置 PDF 阅读器**：高亮和笔记；选中文字发给对话；按页码和位置跳到对应图。
- **对话 / Agent**：会话可以挂在图谱、论文或关系上，可多个、可续聊。Agent 可按需读论文、查本地论文库、联网检索；它发现的新论文会以虚线候选节点进入图谱，确认后转正。
- **其他**：论文库标题与正文全文搜索；导出图谱为 Markdown 大纲（参考文献附 DOI 链接）；用量与费用统计；数据备份与迁移；浅色 / 深色 / 跟随系统主题。

## 安装

1. 从 [Releases](https://github.com/Citrus086/graphictero/releases) 下载 `Graphictero-<版本>-arm64.dmg`。
2. 打开 dmg，把 `Graphictero.app` 拖进「应用程序」。

注意：

- **只支持 Apple Silicon（M 系列芯片）Mac。**
- **应用没有签名和公证。** 第一次打开时请在「应用程序」里右键（或按住 Control 点按）Graphictero，选择「打开」，再在弹窗里确认。也可以在终端执行：

  ```bash
  xattr -dr com.apple.quarantine /Applications/Graphictero.app
  ```

## 使用前准备

- **DeepSeek API Key（必需）**：关系、详情页和对话都调用 DeepSeek，需要你自己的 Key，在「设置 → 语言模型」里填写。Key 只保存在本机数据目录的 `.env` 里，不进入备份。调用费用由你自己的 DeepSeek 账户承担，可在「设置 → 用量与费用」查看。
- **OpenAlex API Key（可选）**：用于获取引用关系和补全 DOI，在「设置 → 导入来源」填写。
- **Zotero（建议）**：论文主要从本机 Zotero 导入。
- **MinerU（PDF 解析）**：第一次在「设置 → PDF 解析」安装时，会在应用数据目录里建 Python 环境并下载模型（几 GB，按 `uv.lock` 锁定版本）。这一步需要本机已装 [uv](https://docs.astral.sh/uv/)（例如 `brew install uv`）。解析在本机 CPU 上运行，比较慢。

默认数据目录是 `~/Library/Application Support/Graphictero/`，可以在设置里修改。

## 从源码构建

需要 macOS（Apple Silicon）、Node.js 22 和 [pnpm](https://pnpm.io/)。

```bash
git clone https://github.com/Citrus086/graphictero.git
cd graphictero
pnpm install --frozen-lockfile

pnpm dev:isolated   # 开发模式，使用独立的开发数据目录（推荐）
pnpm typecheck      # 类型检查
pnpm test           # 单元测试（vitest）
pnpm build          # 构建
pnpm pack:mac       # 打包 macOS arm64 应用，产物在 release/
```

如果 pnpm 在安装最后报 `ERR_PNPM_IGNORED_BUILDS`，可以运行 `node scripts/check-electron-dist.mjs --runtime` 确认 Electron 和原生模块是否完整；不完整时运行 `pnpm fix:electron-dist`。

`pnpm dev:isolated` 默认把数据放在 `~/Library/Application Support/Graphictero-dev`，不会和已安装的应用混用；`pnpm dev:isolated:tmp` 每次用一次性的临时目录。更多说明见 [docs/dev.md](docs/dev.md)。MinerU sidecar 的说明见 [sidecar/mineru/README.md](sidecar/mineru/README.md)。

## 反馈

遇到问题或有想法，欢迎在 [Issues](https://github.com/Citrus086/graphictero/issues) 里提，有 Bug 和功能建议两个模板。报 Bug 时请附上应用版本和 macOS 版本。请不要在 Issue 里贴 API Key。

## 许可证

[MIT](LICENSE) © 2026 Citrus086

---

<a id="english"></a>

## English

Graphictero is a small desktop app I built for my own paper reading. Zotero is good at storing papers, but not at expressing how one paper relates to another. Graphictero puts papers on a graph and uses an LLM to generate relations between them (a relation type plus an editable one-sentence statement), to help trace how a line of research developed, e.g. when writing a survey.

It is single-user and local-first: the library, PDFs and graphs stay in a data folder on your Mac. The project is early and rough around the edges; feedback is welcome.

> TODO: screenshots coming.

### Features

- **Library and import**: its own paper library, imported one-way from Zotero (a whole collection or selected items); nothing is written back to Zotero. Missing PDFs can be fetched from configured sources (arXiv, Unpaywall and other open-access sources, a custom URL template) or dropped in manually.
- **Relationship graphs**: multiple graphs; drag paper nodes freely or auto-arrange the layout. AI-generated relations go straight onto the graph and can be edited, rewritten by the AI, or deleted.
- **Decluttering**: hovering or selecting a paper highlights its direct neighbourhood and dims the rest; filter by relation type (with per-type counts and a reset); focus mode (1 or 2 hops) via right-click → "Focus on this paper" or `F`, and `Esc` to leave and restore the viewport.
- **PDF parsing**: local parsing with [MinerU](https://github.com/opendatalab/MinerU) (listens on 127.0.0.1 only) to extract text, figures and formulas.
- **Paper detail pages**: generated after parsing and cached, with manual regeneration. Besides text they can include figures from the paper, ECharts charts, Mermaid diagrams and interactive explainers: controls (sliders, number inputs, selects, toggles) for formula parameters, with curves and values computed locally (no model-generated code is executed).
- **Built-in PDF reader**: highlights and notes, send a selection to the chat, jump to a figure by page and position.
- **Chat / agent**: sessions attached to a graph, paper or relation; multiple and resumable. The agent can read papers on demand, search your library and the web; papers it finds appear as dashed candidate nodes that you can accept.
- **Also**: title and full-text search, Markdown outline export (references with DOI links), usage and cost tracking, backup and data migration, light / dark / system theme.

### Install

1. Download `Graphictero-<version>-arm64.dmg` from [Releases](https://github.com/Citrus086/graphictero/releases).
2. Open the dmg and drag `Graphictero.app` into Applications.

- **Apple Silicon Macs only.**
- **The app is not signed or notarized.** On first launch, right-click (or Control-click) the app in Applications, choose **Open**, then confirm. Or run:

  ```bash
  xattr -dr com.apple.quarantine /Applications/Graphictero.app
  ```

### Requirements

- **DeepSeek API key (required)**: bring your own key and enter it in Settings → Language model. It is stored only in the local data folder's `.env` and is excluded from backups. API costs go to your own DeepSeek account.
- **OpenAlex API key (optional)**: for references and DOI lookup, in Settings → Import sources.
- **Zotero (recommended)**: papers are mainly imported from your local Zotero.
- **MinerU**: the first install from Settings → PDF parsing creates a Python environment in the app data folder and downloads models (several GB, versions pinned by `uv.lock`). It needs [uv](https://docs.astral.sh/uv/) installed (e.g. `brew install uv`). Parsing runs on the CPU and is slow.

### Build from source

Requires macOS on Apple Silicon, Node.js 22 and [pnpm](https://pnpm.io/).

```bash
git clone https://github.com/Citrus086/graphictero.git
cd graphictero
pnpm install --frozen-lockfile

pnpm dev:isolated   # dev mode with a separate dev data folder (recommended)
pnpm typecheck
pnpm test           # vitest
pnpm build
pnpm pack:mac       # package the macOS arm64 app into release/
```

If pnpm ends with `ERR_PNPM_IGNORED_BUILDS`, run `node scripts/check-electron-dist.mjs --runtime` to check that Electron and the native modules are complete, and `pnpm fix:electron-dist` if they are not.

See [docs/dev.md](docs/dev.md) and [sidecar/mineru/README.md](sidecar/mineru/README.md) for details (in Chinese).

### Feedback

Please open an [issue](https://github.com/Citrus086/graphictero/issues) (bug report or feature request templates). Include the app and macOS versions for bugs, and never paste API keys.

### License

[MIT](LICENSE) © 2026 Citrus086

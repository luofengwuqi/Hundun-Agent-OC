# 馄饨Agent-OC

基于 OpenClaw 二开的情绪陪伴 Agent：先接住情绪，再谈事情

> **项目正式名称：馄饨Agent-OC**（D018）。写法为「**馄饨**」（**饨**，食字旁 + 屯）。立项当天曾误记为「馄炖」，用户已澄清为笔误（G09）；如再看到「炖」，一律视为错字。`Agent` 首字母大写，`-OC` 连字符不加空格。
> 远端仓库 slug 与名称对应：Gitee `wonton-agent-oc`、GitHub `Hundun-Agent-OC`（两条都是「馄饨」的音译，无需改名）。
> **本地目录已改名：`/home/wuqi/code/hundun-agent-oc`**（D022，原文见 O09）。原 `healing-agent` 已不再有效，旧路径引用一律作废；git 仓库与两个远端不受目录改名影响（远端按 URL 连，不按本地路径）。

版本：v0.2
更新日期：2026-11-13
适用基准：开发书 v0.3、AGENTS.md v0.2、决策台账 v0.2、验收清单 v0.1
状态：立项 / 需求澄清；未开发、未验证、未上线

本文维护：项目入口、文档分工表、已核实的上游事实、脚手架技术默认与刻意留白、换机指针。
本文不维护：产品范围与验收定义（`docs/PROJECT_PLAN.md`）、决策与 Q/D/O 编号（`docs/DECISIONS.md`）、逐项验收结果（`docs/ACCEPTANCE.md`）、工程与授权边界（`AGENTS.md`）、真实运行命令（本档未建 `docs/RUNBOOK.md`；工程初始化前不写命令）。
规划态声明：本文描述目标与实施约定，不代表已实现；文中提及的目录、脚本、接口与能力均不得视为已经存在。

## 文档分工表（单一事实源约定）

| 文件 | 唯一负责 | 不维护 |
| --- | --- | --- |
| `README.md` | 入口、分工表、上游事实、脚手架默认与留白 | 具体题数、决策号、逐项结果、真实命令 |
| `AGENTS.md` | 编码助手的判断纪律、阶段与授权、续聊顺序、来源边界 | 产品范围、验收结果、命令表 |
| `docs/PROJECT_PLAN.md` | 产品范围、业务规则、数据契约、验收**定义** | 逐项结果、当前进度、运行命令 |
| `docs/DECISIONS.md` | 决策、未决问题、替代关系、换机与续聊恢复 | 需求正文、验收结果 |
| `docs/ACCEPTANCE.md` | 逐项验收状态与证据（唯一结果记录） | 验收定义、范围表 |
| `docs/FEASIBILITY-A.md` | A 方案在上游现有能力内的映射、能力缺口、环境前提、复核入口 | 需求正文、决策、验收结果、实际运行结果 |
| `docs/SHAPE-ELECTRON.md` | Electron 前端路线对比、协议层选项、「削弱工具性」落点、配置自测设计 | 需求正文、决策、验收结果、路线选定结果 |
| `docs/SHELL-SKELETON.md` | 壳的目录职责、引擎启动/就绪/收尾流程、状态与配置落点 | 产品范围、决策编号、逐项验收；**不含具体代码** |
| `.env.example` | 字段名、是否必填、用途 | 任何真实值 |
| `.gitignore` | 排除本地配置、依赖、构建产物与本地记忆 | 产品与设计决策 |

交叉引用只写相对路径与编号，不复述内容。**当前状态见 `docs/DECISIONS.md` 头部状态行，逐项结果见 `docs/ACCEPTANCE.md`**；本页不抄会变的数字。

本档为**轻档**。下列文件属于中/重档，本档刻意未建，**当前不存在**，不得当作已存在或写成可点击链接；出现新的确认方或进入实施期时再升档补建：`docs/STATUS.md`、`docs/RUNBOOK.md`、`docs/CONTRIBUTING.md`、`docs/SOURCES.md`、`docs/RESEARCH.md`、`docs/AGENT_HANDOFF.md`、`docs/CLIENT-CONFIRMATION.md`、`docs/TEAM_PLAN.md`、`docs/prd/`。

## 当前阶段

- 阶段：**骨架已落地并实跑通过**（2026-11-13）。已完成：上游通读、能力边界验证、Electron 形态方案、运行时可行性实测（A08）、仓库连通（双远端 `0b8615a`）、实机跑通 OpenClaw 2026.11.3 并复查旧结论（O04 关闭、O10 新立）、**建工程并跑通引擎生命周期 + 状态页**（`npm run smoke` 全绿、`npm start` 出界面，详见 `docs/SHELL-SKELETON.md` §8）、**三条设计确认**（记忆落点 D024 / 前端 Vue D025 / 托盘常驻 D026）
- 已确定：见 `docs/DECISIONS.md`（D005–D026 已把形态、前端参考、削弱工具性、模型配置、安全口径、来源边界、核心体验、项目关系、前端定位、主动关心、进程模型、项目名、二开层次、危机干预路径、工具面策略、目录改名、私有 Node 来源、**记忆落点、前端技术栈、关窗语义**定下）
- 尚未确定：**Q 清单已归零；开放冲突 0 项**。剩余待办全在 O 清单：O02 模型凭据、O05 安全层缺口、O06 仓库前置、O07 极端情况求助渠道、O12 打包是否裁 docs、**O13 导出记忆 / O14 同步盘风险 / O15 三平台托盘是否统一 / O16 手机接入开关**
- 外部缺件与签认项：见 `docs/DECISIONS.md` 的 O 编号清单
- **开放冲突 0 项**：X01（主动开口）已裁决为「每天一次、时间不固定、可开关」（D014）；X02（与 hundunAgent 的定位）已裁决（D012）
- **下一步**：① 托盘常驻（D026 的剩余部分：关窗隐藏 + 托盘点退出才真退，含 O15 三平台一致性）；② 接对话收发（需先核实 OpenAI 兼容 HTTP 接口的配置键，写错键会让引擎以 78 退出）。**顺序不能倒**：先托盘再对话，否则接完对话用户一关窗，主动关心仍然触发不了
- 一句话现状：**壳已经是馄饨的样子了**（Vue 3 + 奶油白朱红），引擎能起能停、记忆落在卸载不丢的位置；**但还不能说话**，对话是眼下唯一的实质缺口

## 已核实的上游事实（不是本项目的选型决策）

以下均为对 `/home/wuqi/code/openclaw` 实读核对的结果，仅供判断依据使用；**技术基线已由 D005/D013 定为「壳 + OpenClaw 引擎」，原 Q001 的三档选项随之作废**。2026-11-12 一列为一读，2026-11-13 一行起为二读（复核 + 新增）。

| 项 | 已核实事实 | 依据 |
| --- | --- | --- |
| 上游版本 / 许可 | `openclaw@2026.10.10`，MIT | 上游 `package.json`、`LICENSE` |
| 运行形态 | 单进程 CLI + 常驻 Gateway（WebSocket 默认 `127.0.0.1:18789`） | 上游 `docs/concepts/architecture.md` |
| 工具链门槛 | Node `>=24.16.0 <25 \|\| >=26.1.0`，需 `node:sqlite`；pnpm 12.15.0 | 上游 `package.json`、根 `node-version.mjs` |
| 人格机制 | `SOUL.md` / `IDENTITY.md` / `USER.md` / `AGENTS.md` / `MEMORY.md` 在会话首轮注入系统提示词 | 上游 `src/agents/workspace-bootstrap-policy.ts`、`docs/concepts/agent.md` |
| 记忆与上下文 | memory、context-engine 为**独占槽**；plugin API 标注 experimental | 上游 `src/plugins/memory-state.ts`、`docs/plugins/sdk-overview.md` |
| 前端形态 | Control UI 是 **Vite + SolidJS** 单页应用，由 Gateway 经 HTTP 提供（默认 `http://<host>:18789/`），**直接跟同端口 WS 通信** | `docs/web/control-ui.md` |
| 前端可恢复性 | `ui/` 共 7368 个文件**只存在于 HEAD**，工作区缺失，但 git 对象完好，可恢复 | `git ls-tree -r HEAD -- ui/` |
| 客户端对接面 | ①OpenAI 兼容 HTTP `/v1/chat/completions`（**默认关闭**，支持 `stream:true` SSE）②WS 协议（`packages/gateway-protocol`）③嵌入库 `getReplyFromConfig`（**`package.json` exports 未公开该子路径**） | `docs/gateway/openai-http-api.md`、`src/library.ts`、`package.json` |
| 模型连通性自测 | `openclaw models status --probe` 发真实请求并逐 credential 报延迟；**要求独占状态目录**，需先停 Gateway | `docs/cli/models.md` |
| 运行时硬依赖 | `src/` 中 **1177 个文件**引用 `node:sqlite`；宿主进程必须是具备该内置模块的真实 Node（这排除了「在 Electron 进程里内嵌跑」的默认假设） | `grep -rl node:sqlite src/`、`package.json` |
| 进程生命周期 | 前台 `openclaw gateway run` **不随后启动者退出**；不转发信号的壳会留下仍在服务的 Gateway | `docs/cli/gateway/running.md` |
| 许可 | **MIT**（Copyright (c) 2026 OpenClaw Foundation）；`package.json` `license=MIT`，repository 指向 `github.com/openclaw/openclaw`；未发现企业版 / 许可密钥门控 | `LICENSE`、`package.json` |
| 发行包内容 | npm `files` 白名单 454 条，实际包内只有 `dist/` + 根目录若干 `.mjs` 运行时文件 + `LICENSE`/`CHANGELOG`/`THIRD_PARTY_NOTICES`/`README`/`pnpm-workspace.yaml` + **`docs/`（23 MB）**；**不含 `src/`、测试、`ui/`、`apps/`**（`!dist/control-ui.build-*` 说明 Control UI 构建产物默认也不在包里）。2026-11-13 修正：此前记为「不含 `docs/`」，与 `files` 里的 `docs/` 条目和实装目录 23 MB 的 `docs` 均不符 | `package.json` `files`、`du -sh docs` 实查 |
| **本地 docs 是可选增强** | 运行时会找 `<packageRoot>/docs/docs.json`（`isUsableDocsDir()`）；找不到就把 `docsPath` 置 `null`，系统提示词里的本地文档路径**落回 `https://docs.openclaw.ai`**，其余照常。故缺 docs 是降级（离线查不到本地文档），不是报错——**打包时可省这 23 MB** | `dist/docs-path-*.mjs`、`dist/system-prompt-*.mjs` 的 `docsSection` |
| 模型/插件目录的在线拉取可能被拦 | 引擎自带 SSRF 防护：目标域名解析到私有/内网地址时**直接拒绝**并打 `[security] blocked URL fetch`，涉及 `catalog.openclaw.ai`（模型目录）与 `clawhub.ai`（外部插件目录）。**不影响已配置凭据的对话**，但会让在线目录功能静默失败 | 实跑日志（2026-11-13） |
| 代码规模 | `src/` 非测试 TS **14,554 个、约 132 MB**；测试文件 12,202 个，占了 `src/`（约 303 MB）的大头，且不进发行包 | `find` / `du` 实查 |
| 插件可裁剪 | 191 个 `extensions/`，manifest 支持 `bundledDefaultEnabled: false`；`src/` **不 import 顶层 `extensions/`**，插件边界干净 | `extensions/*/openclaw.plugin.json`、`grep` 实查 |
| 上游工作区状态 | git 索引为空（约 6.4 万条 staged deletion）；`ui/`、`tools/` 目录缺失 | 2026-11-12 `git status` / `git ls-files` 实查 |
| **实际运行版本** | **2026.11.3**（847611d），npm 装在 `~/.local/lib/node_modules/openclaw`，经 `~/.local/bin/openclaw` 调用。**与本地上游仓库的 2026.10.10 `dist/` 不是同一份** —— 判断一律以**运行中的版本**为准 | `openclaw --version`、`readlink -f` 实查 |
| 工具面可配置收紧 | 两档：`tools.profile: "minimal"` 只留 `session_status` + `gateway`(update)；更精细的是 `tools.exec.mode: "allowlist"`，**只跑白名单命令、未命中直接拒绝、不弹审批**。注意 `docs/concepts/agent.md` 那句「core tools are always available」后半是 `subject to tool policy`——「默认在」不等于「删不掉」 | `docs/gateway/config-tools/tool-policy.md`、`docs/tools/exec-approvals.md` |
| **exec 白名单能锁到参数级** | 条目为 `pattern`（可执行文件）+ `argPattern`（**ECMAScript 正则或精确 argv 哈希**，匹配去掉 argv[0] 后的参数串）。即「只能调用写好的指令」可以**由配置强制**，不必靠提示词。注意 `argPattern` 匹配的是**去掉 argv[0] 后**的参数串（手写条目单空格连接，须 `^...$` 锚定），只写 path-only 条目会**回落**到未匹配参数，等于没锁 | `docs/tools/exec-approvals.md` L466–510 |
| **Skills 可带脚本，但跑不动自己** | `skills/` 下既有 `SKILL.md`（提示词里的说明书），也**可以**附带 `scripts/*.mjs`、`*.py`、二进制（如 `sherpa-onnx-tts`）。但说明书里写的只是**建议动作**（`{baseDir}/scripts/meme.mjs suggest ...`）——真正执行必须经 `exec` 工具。**故锁死 `exec` 即等于让所有 skill 的脚本能力一并失效**，这是 D021 的额外收益，此前未写清 | `skills/meme-maker/SKILL.md`、`find skills -type f` 实查 |
| `tools.exec.mode` 的五档语义（精确版） | `deny` 全禁；`allowlist` **只跑白名单、未命中不跑也不问**；`ask` 用白名单、**未命中会问人**；`auto` 命中直接跑、未命中给 `allow`/`deny`/`ask` 三选；`full` 无策略提示。**`allowlist` ≠ `ask`**：前者静默拒绝，后者弹窗。陪伴场景下弹窗是灾难，故选 `allowlist`——但要接受「静默拒绝」的体验代价（用户只会觉得"它做不到"） | `docs/tools/exec-approvals.md` L196–205（2026-11-13 逐档核对） |
| 第三方插件落点 | `~/.openclaw/extensions`、`<workspace>/.openclaw/extensions`、`plugins.load.paths`；**不需要改包内文件**。`plugins.entries.<id>.hooks.allowPromptInjection` 是核心显式管「谁能改提示词」的开关 | `docs/gateway/config-extensions.md` |
| 内置记忆工具**无写入能力** | 工具共 4 个：`memory_search`、`memory_get`、`memory_entry_origins`、`memory_session_tombstones` —— **全是读或元数据，没有写、也没有删单条**。另有 CLI `openclaw memory forget`，但它是**会话级排除**（让某些 session 不再进未来扫描），不是删除具体记忆内容 | `docs/concepts/memory.md`、`docs/cli/memory.md`（2026-11-13 修正：此前误记为「只有 search/get 两个」） |
| **记忆落盘不靠工具（关键）** | 两条写路径：①**compaction 前的 memory flush**，靠 agent 调 `write` 工具写日常笔记，**受工具策略约束**；②**Dreaming**（默认开启、后台 cron、`tool-free completion`），由核心直接改写 `MEMORY.md`，**不经模型的手、不受工具策略影响** | `docs/concepts/memory.md` L246–281、`docs/concepts/dreaming.md` |
| 工具面与记忆的约束关系 | `minimal` 会掐掉 memory flush 依赖的 `write`，记忆退化为「等 Dreaming 跑过」。→ **X03 已裁决（D021）**：不追求工具清零，保留 `write`，改从「动作白名单」压工具性 | `docs/concepts/memory.md` L246–281；`DECISIONS.md` X03、D021 |
| 危机干预（新版复查） | 2026.11.3 的 `dist/` 与 `docs/` 对 `suicide` / `self-harm` / `危机干预` / `心理援助` 仍**全部零命中** —— G1 结论不因版本变化失效 | `grep -rli` 实查 |
| 真机引导产物 | `~/.openclaw/workspace/` 下 `AGENTS.md`、`SOUL.md`、`IDENTITY.md`、`USER.md`、`BOOTSTRAP.md` 五件齐备，`state/openclaw.sqlite` 1.6 MB —— **「人格即文件」在真机上得到证实** | 实查目录 |
| 私有 Node 运行时 | 上游自带「找不到合格 Node 就从候选里挑一个、必要时下载并校验」的机制，缓存在 `~/.openclaw/tools/cli-node`（或 `OPENCLAW_HOME` 下的同路径）；**但非交互调用（CI / JSON / `--yes` / spawn）一律不提示也不安装** | `docs/install/node.md` |
| 状态整体重定位 | `OPENCLAW_HOME` 可把默认状态目录、配置、agent 目录、**凭据**、installer 工作区一起搬到指定 home；优先级 `OPENCLAW_HOME > $HOME > USERPROFILE` | `docs/help/environment.md` |
| 构建产物可用性 | 上游 `dist/` 已构建（8844 文件）；`node dist/index.js --version` → `OpenClaw 2026.10.10 (af7ea2b)`，退出码 0（2026-11-13 用 Node v24.22.3 实测） | 本地实跑 |

**分发义务（MIT 的硬要求）**：打包成 app 对外分发时，必须随附 `LICENSE` 全文与 `THIRD_PARTY_NOTICES.md`（后者声明了打包进来的第三方依赖）。这是法律义务，不是礼貌——建议放在「关于」页且不可移除。

第一步的两份通读报告保存在**上游仓库**的 `.workbuddy/reports/` 下（`OpenClaw-模块与功能全清单.md`、`OpenClaw-全量功能项明细.md`），不属于本项目文件，换机时需单独复制或重新生成。

## 项目结构

以下只列当前**真实存在**的文件；规划中的目录不写成已经存在。

```text
hundun-agent-oc/
├── README.md
├── AGENTS.md
├── CLAUDE.md -> AGENTS.md          # 符号链接，不维护两份
├── package.json                    # main → dist/main/main.js；start / build / smoke / pack
├── tsconfig.json                   # ES2022 + CommonJS + strict
├── .gitignore
├── .env.example
├── src/
│   ├── main/
│   │   ├── main.ts                 # Electron 主进程：窗口、IPC、引擎启动、退出收尾
│   │   └── engine/                 # 引擎生命周期五模块
│   │       ├── paths.ts            # 路径唯一事实源（不 import electron，便于单测）
│   │       ├── port.ts             # 空闲端口探测（base 18890）
│   │       ├── config.ts           # 生成 openclaw.json（D021 工具策略落地点）
│   │       ├── supervise.ts        # spawn / 就绪探测 / 停止 / 接管孤儿
│   │       └── errors.ts           # 退出码 → 分类 → 用户可读文案
│   ├── preload/index.ts            # contextBridge 白名单，不暴露 token / fs / 裸 ipcRenderer
│   └── renderer/                   # Vue 3 前端（D025）
│       ├── index.html              # <!--BUNDLE--> 占位，构建时替换成 assets 引用
│       ├── public/                 # logo.svg、icon.png，原样拷进 dist
│       └── src/
│           ├── main.js             # createApp(App).mount
│           ├── App.vue             # 外壳 + 对话列 + 设置页
│           ├── styles.css          # 视觉基线（前 2040 行来自参考项目 + hx- 追加）
│           └── markdown.js         # 极简 markdown（对话渲染用）
├── scripts/
│   ├── build.mjs                   # 两段：tsc(main/preload) + esbuild(renderer, 含 .vue 编译)
│   ├── dev-launch.mjs              # 开发期启动器：处理宿主 IDE 的 Electron 环境坑
│   ├── dev-shot.mjs                # CDP 截图，改完 UI 用它验渲染（npm run shot）
│   ├── dev-engine-smoke.mjs        # 引擎生命周期冒烟（起→就绪→收尾→断言无孤儿）
│   ├── launch-desktop.sh           # 一键启动：选合格 node、验依赖与引擎、构建、启动（桌面入口调用它）
│   └── probe-electron-runtime.mjs  # 早期诊断脚本（G06 授权）
└── docs/
    ├── PROJECT_PLAN.md
    ├── DECISIONS.md
    ├── ACCEPTANCE.md
    ├── FEASIBILITY-A.md
    ├── SHAPE-ELECTRON.md
    └── SHELL-SKELETON.md           # 壳的目录与生命周期设计稿 + §8 实测记录
```

**怎么跑**：

```bash
npm install          # 若 Electron 二进制没下下来：ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js
npm run smoke        # 只验引擎生命周期，不开窗口，适合 CI
npm start            # 构建 + 开窗口
npm run shot -- --out /tmp/a.png   # 给运行中的窗口截图（另开终端跑，验渲染用）
```

`npm start` 走 `scripts/dev-launch.mjs` 而不是直接 `electron .`，这是有原因的：它会摘掉宿主注入的 `ELECTRON_RUN_AS_NODE`、忽略不适用的 `NODE_OPTIONS`、在 Linux 上发现 SUID 沙箱不可用时降级 `--no-sandbox` 并打印修法。直接 `electron .` 在 VS Code / Cursor 这类终端里会以 `Cannot read properties of undefined (reading 'whenReady')` 崩掉——那**不是代码问题**，详见 `docs/SHELL-SKELETON.md` §8.2。

**前端现状（D025）**：Vue 3，视觉基线取自 `/home/wuqi/code/hundunAgent`。构建分两段——主进程走 `tsc`（保类型检查），渲染层走 `esbuild + @vue/compiler-sfc`（不用 Vite：本机内存受限时 Vite 会 OOM）。**这一版刻意不能对话**，输入框是禁用的，页面上明说原因。

`.workbuddy/memory/` 是本项目的本地工作日志（`2026-11-13.md` 起），`.gitignore` 已排除——换机时需手动带走，见 `docs/DECISIONS.md` 00 节。

## 脚手架里替你定的技术默认

以下是**实现细节，不是需求决策**；如有异议改起来很便宜，但不改就会默认沿用。

| 项 | 默认 | 理由 |
| --- | --- | --- |
| 文档位置 | 全部放 `docs/`，根只留 README / AGENTS / CLAUDE.md | 入口与台账分层，避免根目录堆积 |
| 文档格式 | Markdown，简体中文 | 便于逐项回签与 diff；编号不被翻译影响 |
| 编号空间 | `Q` 问题、`D` 决策、`O` 挂账、`F` 功能、`A` 验收行，编号分配后不复用 | 各套编号独立，改顺序等于改推理链 |
| `CLAUDE.md` | 指向 `AGENTS.md` 的符号链接 | 维护两份必然分叉 |
| 本地记忆 | `.gitignore` 排除 `.workbuddy/memory/` | 长期约定含过程判断，不随代码入库；换机需手动带走 |
| 验收状态 | 未实现 / 通过 / 失败 / 未执行 / 受环境阻塞五档 | 禁止「基本可用」这类不可判定描述 |
| 文档更新策略 | 台账与验收清单追加、开发书重写升版、README 摘要覆盖 | 快照型与追加型不混在同一节 |

## 脚手架刻意不做的部分

逐项写明理由。现在编出来的东西后面会全部推翻，还会被误当成已定方案。

- **二开形态与前端路线**：已于 G03 收口——D013 定「壳 + OpenClaw 引擎」，R1/R2/R4 排除。进程模型已由 G06 实测敲定（D017：外挂子进程 + 自带 Node + HTTP 起步，O01 关闭）；**私有 Node 的具体来源与落位仍待 O08**，属打包细节，不影响范围。判定证据见 `docs/FEASIBILITY-A.md` 与 `docs/SHAPE-ELECTRON.md`。
- **`SOUL.md` 人格措辞与陪伴话术**：语气、边界、回复长度要真人确认，不能用模板语气冒充产品人格；关联 Q004。
- **危机干预话术与本地求助资源**：涉及安全，必须由真人确认口径与适用地区，不得由脚手架猜；关联 Q004。
- **渠道、模型供应商、记忆插件选型**：关联 Q002/Q003；上游 memory 是独占槽，选错要整体迁移。
- **本项目的 workspace 目录、cron 表达式、TTS 参数**：等 Q001 与技术基线定稿，现在写等于编造实施细节。注意区分：`docs/FEASIBILITY-A.md` 记的是**上游已有的配置键与默认值**（可核实的事实），不是本项目的选型取值。
- **消息协议、数据表结构、UI / 语音界面**：一期范围未定，现在写会被全部推翻。
- **真实运行命令、CI、部署方式**：工程尚未初始化，编一条看起来合理的命令会被助手反复尝试；升档补建 `docs/RUNBOOK.md` 后统一维护。
- ~~**Git 仓库地址与分支策略**~~：**已落实**（G07）——`main` 分支单一事实源；`origin`=Gitee（fetch+push）、`github`=GitHub（push），`git push origin main` 一次推两边。分支策略仍只有 `main`，未定长期分支模型。

## 换机与续聊恢复

见 [`docs/DECISIONS.md` 00 节](docs/DECISIONS.md#0-换机与续聊恢复)。AI 本地记忆（`.workbuddy/memory/`）不在 Git 里，换机需单独带走。

## 下一步交给谁

| 需要什么 | 转给哪个 skill | 交回哪份文件 |
| --- | --- | --- |
| 需求正文、编号证据链、决策台账编号体系、对外核实单 | `prd-creator` | `docs/prd/`（重档才建）；本项目轻档可暂不启用，`docs/PROJECT_PLAN.md` 仍是范围骨架，不是 PRD 正文 |
| `AGENTS.md` / `CLAUDE.md` 的精修、审计或瘦身 | `agents-md` | `AGENTS.md`（符号链接自动跟随） |

本骨架只定结构与事实源，不写 PRD 正文，也不替代工程规则精修。两者都不重复生成本 skill 已建的文件。

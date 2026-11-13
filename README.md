# 治愈系陪伴 Agent

基于 OpenClaw 二开的情绪陪伴 Agent：先接住情绪，再谈事情

版本：v0.1
更新日期：2026-11-12
适用基准：开发书 v0.1、AGENTS.md v0.1、决策台账 v0.1、验收清单 v0.1
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
| `.env.example` | 字段名、是否必填、用途 | 任何真实值 |
| `.gitignore` | 排除本地配置、依赖、构建产物与本地记忆 | 产品与设计决策 |

交叉引用只写相对路径与编号，不复述内容。**当前状态见 `docs/DECISIONS.md` 头部状态行，逐项结果见 `docs/ACCEPTANCE.md`**；本页不抄会变的数字。

本档为**轻档**。下列文件属于中/重档，本档刻意未建，**当前不存在**，不得当作已存在或写成可点击链接；出现新的确认方或进入实施期时再升档补建：`docs/STATUS.md`、`docs/RUNBOOK.md`、`docs/CONTRIBUTING.md`、`docs/SOURCES.md`、`docs/RESEARCH.md`、`docs/AGENT_HANDOFF.md`、`docs/CLIENT-CONFIRMATION.md`、`docs/TEAM_PLAN.md`、`docs/prd/`。

## 当前阶段

- 阶段：立项 / 需求澄清（G01–G06）。已完成四件：上游通读、A 方案能力边界验证、Electron 形态方案、**运行时可行性实测**（A08 通过：Electron 28.3.3 的 Node 18.18.2 无 `node:sqlite`，不能内嵌 → D017 定为外挂子进程）。前三件是判据材料，未运行验证；第四件是二进制级实测
- 已确定：见 `docs/DECISIONS.md`（D005–D017 已把形态、前端参考、削弱工具性、模型配置、安全口径、来源边界、核心体验、项目关系、前端定位、主动关心、进程模型定下）
- 尚未确定：**Q 清单已归零**。剩余待办全在 O 清单：O02 模型凭据、O04 本机运行时、O05 安全层缺口、O06 仓库前置、O07 极端情况是否给外部求助渠道
- 外部缺件与签认项：见 `docs/DECISIONS.md` 的 O 编号清单
- **开放冲突 0 项**：X01（主动开口）已裁决为「每天一次、时间不固定、可开关」（D014）；X02（与 hundunAgent 的定位）已裁决（D012）
- 一句话现状：**壳 + OpenClaw 引擎**已定（D013），进程模型已实测敲定为**外挂子进程 + 自带 Node**（D017），F01–F06 范围已列；剩下的都是外部前置，不需要再讨论产品口径

## 已核实的上游事实（不是本项目的选型决策）

以下均为 2026-11-12 对 `/home/wuqi/code/openclaw` 实读核对的结果，仅供判断依据使用；**本项目技术基线仍为 Q001 [待确认]**。

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
| 发行包内容 | npm `files` 白名单 454 条，实际包内只有 `dist/` + 根目录若干 `.mjs` 运行时文件 + `LICENSE`/`CHANGELOG`/`THIRD_PARTY_NOTICES`/`README`/`pnpm-workspace.yaml`；**不含 `src/`、测试、`ui/`、`apps/`、`docs/`**（`!dist/control-ui.build-*` 说明 Control UI 构建产物默认也不在包里） | `package.json` `files` |
| 代码规模 | `src/` 非测试 TS **14,554 个、约 132 MB**；测试文件 12,202 个，占了 `src/`（约 303 MB）的大头，且不进发行包 | `find` / `du` 实查 |
| 插件可裁剪 | 191 个 `extensions/`，manifest 支持 `bundledDefaultEnabled: false`；`src/` **不 import 顶层 `extensions/`**，插件边界干净 | `extensions/*/openclaw.plugin.json`、`grep` 实查 |

**分发义务（MIT 的硬要求）**：打包成 app 对外分发时，必须随附 `LICENSE` 全文与 `THIRD_PARTY_NOTICES.md`（后者声明了打包进来的第三方依赖）。这是法律义务，不是礼貌——建议放在「关于」页且不可移除。
| 上游工作区状态 | git 索引为空（约 6.4 万条 staged deletion）；`ui/`、`tools/` 目录缺失 | 2026-11-12 `git status` / `git ls-files` 实查 |

第一步的两份通读报告保存在**上游仓库**的 `.workbuddy/reports/` 下（`OpenClaw-模块与功能全清单.md`、`OpenClaw-全量功能项明细.md`），不属于本项目文件，换机时需单独复制或重新生成。

## 项目结构

以下只列当前**真实存在**的文件；规划中的目录不写成已经存在。

```text
healing-agent/
├── README.md
├── AGENTS.md
├── CLAUDE.md -> AGENTS.md          # 符号链接，不维护两份
├── .gitignore
├── .env.example
├── scripts/
│   └── probe-electron-runtime.mjs  # 唯一的诊断脚本：判断 Electron 能否承载 OpenClaw
└── docs/
    ├── PROJECT_PLAN.md
    ├── DECISIONS.md
    ├── ACCEPTANCE.md
    ├── FEASIBILITY-A.md
    └── SHAPE-ELECTRON.md
```

`scripts/` 目前**只有一个文件**，是 G06 授权的诊断脚本，不是工程脚手架。它不需要安装任何依赖，也不需要图形界面：

```bash
ELECTRON_RUN_AS_NODE=1 /path/to/electron/dist/electron scripts/probe-electron-runtime.mjs
```

`.workbuddy/memory/` 尚未在本项目创建；它是换机恢复约定中要单独带走的本地记忆目录，见 `docs/DECISIONS.md` 00 节。

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

- **二开形态与前端路线**：已于 G03 收口——D013 定「壳 + OpenClaw 引擎」，R1/R2/R4 排除。判定证据见 `docs/FEASIBILITY-A.md` 与 `docs/SHAPE-ELECTRON.md`；**进程模型与协议选型仍待 O01**，那部分是实现细节，不影响范围。
- **`SOUL.md` 人格措辞与陪伴话术**：语气、边界、回复长度要真人确认，不能用模板语气冒充产品人格；关联 Q004。
- **危机干预话术与本地求助资源**：涉及安全，必须由真人确认口径与适用地区，不得由脚手架猜；关联 Q004。
- **渠道、模型供应商、记忆插件选型**：关联 Q002/Q003；上游 memory 是独占槽，选错要整体迁移。
- **本项目的 workspace 目录、cron 表达式、TTS 参数**：等 Q001 与技术基线定稿，现在写等于编造实施细节。注意区分：`docs/FEASIBILITY-A.md` 记的是**上游已有的配置键与默认值**（可核实的事实），不是本项目的选型取值。
- **消息协议、数据表结构、UI / 语音界面**：一期范围未定，现在写会被全部推翻。
- **真实运行命令、CI、部署方式**：工程尚未初始化，编一条看起来合理的命令会被助手反复尝试；升档补建 `docs/RUNBOOK.md` 后统一维护。
- **Git 仓库地址与分支策略**：本目录尚未 `git init`，地址与授权状态均 `[待确认]`。

## 换机与续聊恢复

见 [`docs/DECISIONS.md` 00 节](docs/DECISIONS.md#0-换机与续聊恢复)。AI 本地记忆（`.workbuddy/memory/`）不在 Git 里，换机需单独带走。

## 下一步交给谁

| 需要什么 | 转给哪个 skill | 交回哪份文件 |
| --- | --- | --- |
| 需求正文、编号证据链、决策台账编号体系、对外核实单 | `prd-creator` | `docs/prd/`（重档才建）；本项目轻档可暂不启用，`docs/PROJECT_PLAN.md` 仍是范围骨架，不是 PRD 正文 |
| `AGENTS.md` / `CLAUDE.md` 的精修、审计或瘦身 | `agents-md` | `AGENTS.md`（符号链接自动跟随） |

本骨架只定结构与事实源，不写 PRD 正文，也不替代工程规则精修。两者都不重复生成本 skill 已建的文件。

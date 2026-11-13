# Electron 形态与配置自测方案（判据材料）

版本：v0.3
更新日期：2026-11-12
适用基准：openclaw 2026.10.10 本地检出；hundunAgent 本地检出（仅作壳形态参考）
状态：形态已定（D013）；**进程模型已实测敲定为外挂子进程（D017）**；壳的自测流程未运行验证
本文维护：壳与引擎的边界、四条前端路线的取舍、协议层选项、「削弱工具性」落点、配置自测设计、打包与进程生命周期的坑
本文不维护：产品范围（`PROJECT_PLAN.md`）、决策与编号（`DECISIONS.md`）、验收结果（`ACCEPTANCE.md`）
规划态声明：本文描述可选方案与取舍，不代表已实现或已验证。

> **v0.2 → v0.3 变更**
> - R4（进程内嵌）由「待实测」变为**已实测排除**：Electron 28.3.3 的 Node 18.18.2 无 `node:sqlite` 且不满足 engines。见 §2 结果表与 `scripts/probe-electron-runtime.mjs`。
> - 进程模型落 D017（外挂子进程 + 自带 Node）；O01 关闭。
> - **结论按 Electron 版本成立**，换版本须重跑脚本。

> **v0.1 → v0.2 变更**
> - X02 已裁决（D012）：本项目与 hundunAgent 是**两个目标一致的独立项目**，壳可借鉴、技术栈不必一致、**交付物必须是可安装的 app**。
> - Q007 已答（D013）：**前端只是壳，所有运行逻辑基于 OpenClaw 照搬或二开。**
> - 因此路线由「四选一」收敛为「自建薄壳 + 子进程跑 OpenClaw」。**R4（进程内嵌引擎）被排除**，理由见 §3，不是偏好问题而是硬依赖问题。
> - 新增 §6「打包与进程生命周期」，其中的坑会直接导致「关窗口后进程还在跑」。

## 0. 结论

形态已经定了，不用再选：**壳 + OpenClaw 引擎**（D013）。壳只负责窗口、对话界面、配置导入、自测触发；会话、记忆、人格、模型调用全部在 OpenClaw 侧。

在「壳」的前提下，路线收敛为一条主路 + 一条备选：

- **主路**：自建薄壳（技术栈自选），**以子进程方式运行 OpenClaw**，走它文档化的 HTTP / WS 接口。这是「照搬」——不改上游代码。
- **备选**：真要做二开改动，也在上游仓库里改，壳仍然通过同一个接口对接。**接口不变，换实现**，这样壳不用跟着变。

三条被排除的：R1 壳加载现成 UI（工具性削不掉）、R2 裁剪 Control UI（锁死在上游 monorepo，且 SolidJS 与参考壳不同栈）、R4 进程内嵌引擎（**硬依赖 `node:sqlite`，Electron 无法保证**）。

## 1. OpenClaw 前端与运行时的既有事实（已核实）

| 项 | 事实 | 证据 |
| --- | --- | --- |
| Control UI 包名 | `openclaw-control-ui`（私有包） | `HEAD:ui/package.json` |
| 技术栈 | **Vite + SolidJS**（`@solidjs/signals`、`@solidjs/web` 2.0 rc） | 同上 |
| 规模 | 7368 个文件在 HEAD 中；工作区缺失，git 对象完好，可恢复 | `git ls-tree -r HEAD -- ui/` |
| 提供方式 | 由 Gateway 经 HTTP 提供，默认 `http://<host>:18789/`；`gateway.controlUi.enabled` 可热关闭 | `docs/web/control-ui.md` |
| 通信 | 直接跟**同端口** Gateway WebSocket 说话 | 同上 |
| 依赖形态 | 20+ 个 `workspace:*` 内部包 → **不能脱离 monorepo 单独构建** | `HEAD:ui/package.json` |
| **运行时硬依赖** | `src/` 中 **1177 个文件**引用 `node:sqlite`；`engines` 要求 Node `>=24.16.0 <25 \|\| >=26.1.0` | `grep -rl node:sqlite src/`、`package.json` |
| 前台运行 | `openclaw gateway run`；**前台 Gateway 不随后启动者退出** | `docs/cli/gateway/running.md` |
| 私有运行时 | 启动时会在「已可用的兼容运行时」中查找，第一项是 *the private OpenClaw runtime* | `docs/install/node.md` |

最后两行是壳方案的地基，也是 §6 两个坑的来源。

## 2. 四条路线（R4 已排除）

| 路线 | 做法 | 工具性 | 结论 |
| --- | --- | --- | --- |
| R1 壳加载 | Electron `loadURL()` 指向 Gateway 的 `/` | 100% 保留 | **排除**：D007 要削弱工具性 |
| R2 裁剪 Control UI | 恢复 `ui/` 删组件，build 后塞进 Electron | 可削 | **排除**：锁死上游 monorepo + 20 个 workspace 包；SolidJS 与参考壳不同栈；每次跟上游合并冲突 |
| **R3 自建薄壳 + 子进程** | 自选技术栈写壳，spawn OpenClaw，走 HTTP/WS | 天然没有 | **采纳方向**（D013） |
| R4 进程内嵌引擎 | 壳的进程直接 `import` openclaw 跑 agent | 天然没有 | **排除**：见下 |

**R4 为什么被排除（已实测，不再是推断）**

不是「能不能 import」的问题，是「宿主进程有没有 `node:sqlite`」的问题。`src/` 里 1177 个文件引用这个 Node 内置模块，没有 polyfill 空间。

2026-11-12 用 `scripts/probe-electron-runtime.mjs` 实测，结果如下：

| 运行时 | Node | `node:sqlite` | engines | 判定 |
| --- | --- | --- | --- | --- |
| Electron 28.3.3（本机两个副本同版本） | 18.18.2 | **`ERR_UNKNOWN_BUILTIN_MODULE`** | 不满足 | 不可内嵌 |
| 本机 Node（对照） | 22.22.2 | 可用，文件库 WAL 正常 | 不满足 | 不可内嵌 |

两项检查**同时**不通过，而且 `node:sqlite` 是在 import 阶段就失败，没有兜底余地。

**但这条结论的边界要说清楚**：本轮只测到 Electron 28.3.3，本机没有更新的 Electron 可测。它证明的是「Electron 28 不行」，**不等于「所有 Electron 都不行」**——较新的 Electron 可能带上 Node 22+/24+ 并暴露 `node:sqlite`。所以结论按版本成立，换 Electron 版本必须重跑这个脚本，不能引用本表当永久结论。

脚本可复跑，headless 环境无需图形界面：

```bash
ELECTRON_RUN_AS_NODE=1 /path/to/electron/dist/electron scripts/probe-electron-runtime.mjs
node scripts/probe-electron-runtime.mjs   # 对照组
```

退出码 0 = 可内嵌，1 = 不可内嵌。

## 3. 协议层：壳跟谁说话

内嵌（a）已随 R4 排除，剩两条：

**(b) HTTP `/v1/chat/completions` — 建议起步**
Gateway 的 OpenAI 兼容面，**默认关闭**，需显式打开 `gateway.http.endpoints.chatCompletions.enabled`。

- 与 WS 同端口复用（`127.0.0.1:18789`）
- 支持 `stream: true`，SSE 增量返回——陪伴界面的「打字机效果」靠它
- 跑的是**同一条 agent codepath**，路由、权限、配置与 Gateway 一致
- 局限：只有对话面。会话列表、主动开口事件都不在这个面上

**(c) WS 协议 — 需要时再补**
协议在 `packages/gateway-protocol`，客户端在 `packages/gateway-client`。全套能力；代价是要么把两个 workspace 包带进壳，要么自己按协议实现一遍。

建议：**(b) 起步，需要会话列表或主动开口事件时补 (c)。** 壳越薄越好，第一版不要同时上两条。

## 4. 「削弱工具性」削什么

最容易做错的地方：**工具性不在前端，在配置和提示词。** 界面做成一个聊天框，模型照样会调工具。既然壳不做业务逻辑（D013），这件事**必须在 OpenClaw 侧用配置做完**。

| 层 | 做什么 | 落点 |
| --- | --- | --- |
| 能力层 | 技能清空、工具收窄、不装 MCP | `agents.entries.*.skills: []`（空数组＝无技能，且**不与 defaults 合并**）、工具 allow/deny |
| 提示词层 | 换掉「执行偏向」与「工具调用风格」 | `sectionOverrides` 可替换 `execution_bias`、`tool_call_style` |
| 界面层 | 只留对话，最多加一个「最近说过的事」 | 壳自己的事 |

三层都要做。只做界面层，等于给工具换了个温柔的外壳。

## 5. Q003：导入配置 + 自测能不能调 LLM

**结论：自测不需要自己写探针。**

你参考的 opencode 形状（读自本机 `~/.config/opencode/opencode.jsonc`，凭据已脱敏，仅看结构）：

```
$schema
provider.<id>.npm           # SDK 包名
provider.<id>.options       # baseURL / apiKey / 超时
provider.<id>.models.<id>   # name / limit{context,output} / modalities / options / variants
```

凭据另有 `auth.json` 单独存。好处是「一个文件描述所有供应商」，换模型只改文件。

**OpenClaw 侧已有等价能力**：`openclaw models status --probe` 就是真实请求的连通性自测——

- `--probe` 发真实 prompt-only 请求，逐 credential 报结果与延迟
- 可调 `--probe-timeout`（默认 8000）、`--probe-concurrency`（默认 2）、`--probe-max-tokens`（默认 8）
- 支持 `--json`，可直接渲染成绿灯列表
- 会消耗 token、可能触发限流——文案要跟用户讲清楚

**关键限制与化解**：`--probe` **要求独占状态目录**，文档明确要先 `openclaw gateway stop`。放设置页里会跟正在聊天的 Gateway 抢锁。但**首次配置时 Gateway 本来就没起**——把自测放在引导流程，这个限制天然满足。

所以 Q003 = 翻译 + 调用 + 呈现：

1. 用户导入配置文件
2. 翻译成 OpenClaw 的 provider / auth 配置
3. 跑 `openclaw models status --probe --json`
4. 渲染每个 provider / profile 的 ok、延迟、错误码

**待定**：吃哪种格式。直接吃 OpenClaw 形状（零转换，用户要学新格式）vs 吃 opencode 形状 + 写转换器（上手快，但 `variants`、`npm` 在 OpenClaw 无对应物会丢信息）。倾向**直接吃 OpenClaw 形状**，另附 opencode 导入适配器——转换器只是入口，不是事实源。

## 6. 打包与进程生命周期（「能安装的 app」的四个坑）

D012 要求交付物是**可安装的 app**。这条路有四个会「不报错但会错」的地方：

**坑 1：关窗口后 Gateway 还在跑。**
文档原话：前台 Gateway **不随后启动者退出**；不转发信号的壳会让 Gateway 在壳被杀后继续服务。后果是僵尸进程 + 端口占用 + 下次启动冲突——而且用户看不到任何报错。

对策：壳退出时**按进程名 `openclaw-gateway` 收尾**，或让启动器转发信号（`exec openclaw gateway run`）。这条必须写进壳的退出路径，不能只靠 `app.quit()`。

**坑 2：Electron 的 Node 未必能跑 OpenClaw。**
`engines` 要求 `>=24.16.0 <25 || >=26.1.0`，且需要 `node:sqlite`。壳**随包携带独立的 Node 运行时**比赌 Electron 内置 Node 更稳；OpenClaw 自己也有「private runtime」的查找机制可以复用（`docs/install/node.md`）。

**坑 3：固定端口 18789 会撞。**
用户可能同时开着官方 CLI 或第二个实例。需要探测已有实例并复用，或申请动态端口后告诉壳。

**坑 4：状态目录与「卸载不丢记忆」。**
记忆是产品命根子（D011「被记住」）。状态目录要给用户可预期、可备份的位置，卸载程序不得连带删除。这一条要写进安装器行为，不是靠用户自觉。

## 7. 已裁决与仍待定

- ~~**X01 主动开口机制**~~ → **已裁决**（D014）：每天一次、时间不固定、用户可开关。实现建议用 **pacing** 而非 stagger：
  - `stagger` 的偏移由 `resolveStableCronOffsetMs(jobId, staggerMs)` 按 jobId **确定性派生**（`src/cron/service/jobs-scheduling.ts`），每天同一时刻——**不满足「时间随机」**。
  - `pacing.min` / `pacing.max` 允许每次跑完由 agent 提议 `next_check` 并夹在边界内（`src/cron/pacing.ts`、`docs/automation/cron-jobs/schedules.md`），才是真正的漂移。建议 `20h–28h`。
  - **壳不参与调度**：壳只提供一个开关（对应 automations 的 enable/disable），时间的决定权在引擎侧。这是 D013 的直接推论——调度是运行逻辑，不该出现在壳里。
- ~~**R4 是否可行**~~ → **已实测**（2026-11-12，见 §2 表）：Electron 28.3.3 的 Node 18.18.2 无 `node:sqlite` 且不满足 engines → **不可内嵌，进程模型定为外挂子进程**（D017）。结论按 Electron 版本成立，换版本须重跑 `scripts/probe-electron-runtime.mjs`。
- **配置格式**（待定）：OpenClaw 原生形状 vs opencode 形状 + 转换器。

## 8. 前置阻塞

- 本机 Node v22.22.2 不满足 engines —— 见 `FEASIBILITY-A.md` §5
- openclaw 未安装；本目录尚未 `git init`；壳工程未建
- 恢复 `ui/` 仅在走 R2 时才需要，而 R2 已排除 → 这条依赖当前不阻塞

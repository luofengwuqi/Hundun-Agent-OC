# 壳的目录结构与启动/收尾流程（设计稿）

版本：v0.1
更新日期：2026-11-13
适用基准：D017（进程模型）、D019（不改上游源码）、D021（工具面策略）、O04（实机 2026.11.3）
状态：**设计稿；未写一行代码、未创建任何目录。**
本文维护：壳的目录职责划分、引擎生命周期（启动 / 就绪 / 收尾）、状态与配置落点。
本文不维护：产品范围（`PROJECT_PLAN.md`）、决策编号（`DECISIONS.md`）、逐项验收（`ACCEPTANCE.md`）、真实运行命令手册（本档未建 `docs/RUNBOOK.md`，工程初始化前不写）。

**规划态声明**：下文所有路径、文件名、进程参数都是**计划**，不代表已经存在。

## 0. 三条从实机得来的硬约束

这三条决定了后面的结构，先说清楚来源：

| # | 约束 | 依据 |
| --- | --- | --- |
| 1 | 引擎以**独立子进程**运行，壳不内嵌（Electron 自带的 Node 跑不了 `node:sqlite`） | D017、A08 实测 |
| 2 | **不许改安装包内任何文件**——升级会整包替换 | D019 |
| 3 | 工具性由**动作白名单**控制，不靠删工具 | D021 |

## 1. 目录结构

以下是**已建成**的结构（2026-11-13 实跑通过）。标注 `[计划]` 的是设计里有、还没建的部分——留着是为了说明位置，不是已经存在。

```text
hundun-agent-oc/
├── package.json                   # ✔ main 指向 dist/main/main.js
├── tsconfig.json                  # ✔ ES2022 / CommonJS / strict
├── scripts/
│   ├── build.mjs                  # ✔ 两段：tsc(main/preload) + esbuild(renderer, 含 .vue 编译)
│   ├── dev-launch.mjs             # ✔ 开发期启动器，摘掉宿主 IDE 注入的 Electron 环境变量（§8.2）
│   ├── dev-shot.mjs               # ✔ 通过 CDP 给运行中的窗口截图（改 UI 后验渲染）
│   └── dev-engine-smoke.mjs       # ✔ 引擎生命周期冒烟：起→就绪→收尾→断言无孤儿
├── src/
│   ├── main/                      # Electron 主进程
│   │   ├── main.ts                # ✔ app 生命周期、无边框窗口、IPC（ipc 先并入此文件）
│   │   └── engine/
│   │       ├── paths.ts           # ✔ 记忆根/应用数据的唯一事实源（不 import electron）
│   │       ├── port.ts            # ✔ 空闲端口探测（base 18890，避开 18789）
│   │       ├── config.ts          # ✔ 生成 openclaw.json（D021 工具策略在此落地）
│   │       ├── supervise.ts       # ✔ spawn / 就绪探测 / 退出 / 接管
│   │       └── errors.ts          # ✔ 退出码 → 用户可读文案
│   ├── preload/index.ts           # ✔ contextBridge 白名单（不暴露 token / fs / 裸 ipcRenderer）
│   └── renderer/                  # ✔ Vue 3（D025）
│       ├── index.html             # 含 <!--BUNDLE--> 占位，构建时替换成 assets 引用
│       ├── public/                # logo.svg、icon.png，原样拷进 dist
│       └── src/
│           ├── main.js            # createApp(App).mount
│           ├── App.vue            # 外壳 + 对话列 + 设置页
│           ├── styles.css         # 视觉基线（前 2040 行来自参考项目，之后是 hx- 追加）
│           └── markdown.js        # 极简 markdown（对话渲染用）
├── engine/                        # 【只读】打包进安装包，运行时不得写  [计划]
│   ├── node/bin/node              # D023：私有 Node，每平台一份
│   └── openclaw/                  # npm 包原样内容（dist/ + 根级 .mjs + 许可）
├── extensions/                    # 自建插件（D019 允许的唯一写代码处）  [计划]
│   └── care-guard/
└── docs/                          # 设计文档与决策台账
```

与设计稿的两处偏差，记在这里免得下次以为漏了：

- **`main/ipc.ts` 暂并入 `main.ts`**。IPC 目前只有 5 个 handler，拆文件反而要绕一圈才能看懂状态怎么变。等对话收发接上、handler 数超过十个再拆。
- **`electron-builder.yml` 还没建**。打包配置要等 `engine/` 落位后一起写，否则现在写的 `extraResources` 路径都是空的。

**四条结构纪律**：

1. `engine/` 是**只读区**。任何「顺手改一下 dist」的念头都要在这里被挡住——改了下次升级就丢（D019）。
2. `extensions/` 是**唯一**放我们代码的地方，且必须能独立于 `engine/` 升级。
3. `paths.ts` 是路径的**唯一事实源**。别的模块不许自己拼 `userData` 路径，否则换存储位置时会漏改一处。
4. 渲染进程**不直接连** Gateway。所有请求走主进程 IPC——token 不能进渲染进程（它跑网页内容，最容易出事）。

## 2. 状态与配置落点

用 `OPENCLAW_HOME` 把引擎状态整体搬到一个**我们指定的目录**（依据：`docs/help/environment.md`，`OPENCLAW_HOME` 覆盖默认状态目录、配置、agent 目录、**凭据**、installer 工作区）。

**这个目录是「用户文档目录」，不是应用数据目录**（D024，2026-11-13 修订）。原设计放在 `<userData>` 下，被推翻：卸载器会连它一起删，而那里面装着一个人全部的日记。

| 位置 | 引擎侧 | 说明 |
| --- | --- | --- |
| `<documents>/馄饨Agent-OC/` | `OPENCLAW_HOME` 根 | 记忆根。**卸载不会碰** |
| `<documents>/馄饨Agent-OC/workspace/` | agent workspace | `AGENTS.md` / `SOUL.md` / `IDENTITY.md` / `USER.md` / `MEMORY.md`；用户在界面上能打开这个文件夹 |
| `<documents>/馄饨Agent-OC/openclaw.json` | 配置 | 由 `config.ts` 生成，权限 0600。**内含 gateway token 与可能的模型 key** |
| `<documents>/馄饨Agent-OC/state/` | SQLite 状态 | 会话、记忆索引（O14：同步盘风险） |
| `<userData>/shell-runtime.json` | — | 壳自己的运行时记录（pid/port）。**放在应用数据目录**，卸载可删 |
| `engine/node/`（安装包内） | — | 私有 Node（D023）。不复制到状态目录 |

**取路径必须用 `app.getPath("documents")`**：Windows 上「文档」可能被重定向到 OneDrive，Linux 上取决于 XDG 配置，手拼 `~/Documents` 必错。

**两条不变量**：

1. 引擎状态**绝不写**用户 `~/.openclaw`。否则会和用户自己装的 openclaw 串状态，也会在卸载时留下孤儿数据。
2. 测试**绝不写**真实文档目录。`dev-engine-smoke.mjs` 造一个假 documents 目录传进去。

**卸载行为**：记忆目录不在安装目录内、也不在应用数据目录内，所以卸载器删不到它——**不需要「卸载时抢救」这套机制**。用户要备份时用应用内的「导出记忆」（O13，必须排除凭据）。

**卸载行为**（写进安装器，不是靠自觉）：卸载不删 `engine-home/`；提供独立的「连同记忆一起删除」确认项，且需二次确认并显示路径。记忆是产品命根子（D011）。

## 3. 启动流程

### 3.1 阶段

```text
[0] app ready
     ↓
[1] 解析路径（paths.ts）→ 确保 engine-home 目录存在
     ↓
[2] 首次运行？→ 写 openclaw.json（含 D021 工具策略）→ 否则校验并补齐缺省键
     ↓
[3] 探测空闲端口（避开 18789，避免和用户自己的 openclaw 抢）
     ↓
[4] spawn：<app>/engine/node/bin/node <app>/engine/openclaw/dist/index.js \
         gateway run --bind loopback --auth token --token <生成> \
         --port <上面探到的> [--allow-unconfigured 仅首启]
     环境：OPENCLAW_HOME=<userData>/engine-home
           PATH=<app>/engine/node/bin:<原 PATH>        ← D023，见 §3.1.1
     ↓
[5] 就绪探测：轮询 GET http://127.0.0.1:<port>/readyz 直到 200
     ↓
[6] 告诉渲染进程「可以说话了」
```

#### 3.1.1 为什么要前置 PATH（D023）

壳用**绝对路径** spawn，本来就不依赖 PATH。前置 PATH 是为了**引擎自己起的子进程**、以及壳调用的 `models status --probe` 这类 CLI 也用同一个 Node——否则会出现「主进程跑 Node 24、子命令落到系统的 Node 22」这种错配，表现是子命令报 engines 不满足，而主进程一切正常，非常难查。

**不要**为了「让上游 recovery 找到我们捆的 Node」而复制 122 MB 到状态目录。理由与布局陷阱见 `DECISIONS.md` **D023**：上游私有运行时的层级是 `tools/cli-node/tools/node/bin/node`，不是 `cli-node/bin/node`，按字面猜会猜错。

### 3.2 就绪判据：用 HTTP，不要抓日志

Gateway 暴露三对**无需鉴权**的检查端点（`docs/gateway/health.md`）：

| 端点 | 含义 | 壳怎么用 |
| --- | --- | --- |
| `/healthz` | HTTP 服务活着 | 判断「进程没死」，**不等于能接话** |
| `/startupz` | sidecar 与 agent 库检查已就绪，未在 drain | 启动期进度 |
| `/readyz` | 可接流量（含渠道深检） | **放行条件** |

关键细节：**HTTP 监听早于会话投影完成**，所以 `/healthz` 可能 200 而 `/readyz` 仍 pending。壳如果只看 `/healthz` 就放行，用户会在第一句话上撞到一个还没准备好的引擎。

**不要抓日志判断就绪**——日志文案不是接口，随版本改；`readyz` 是接口。

### 3.3 首启为什么尽量不用 `--allow-unconfigured`

`--allow-unconfigured` 是「配置不合法也允许启动」的逃生门。壳若常态带着它，等于把配置错误的信号永久关掉——出问题时表现为「能启动但说话没反应」，比直接报错难查得多。

做法：**首启由 `config.ts` 写出一份完整可用的 `openclaw.json`**，不带这个参数。只有当配置文件被外部改坏、且用户明确点「仍要启动」时才临时用它。

### 3.4 失败分类（退出码 → 文案）

上游定义了两种要区别对待的失败（`docs/cli/gateway/running.md`）：

| 退出码 | 含义 | 壳该做什么 |
| --- | --- | --- |
| `78` | 配置无效（上游用这个值**阻止 systemd 重启循环**） | **不要自动重试**。显示「配置有问题」+ 打开配置目录 + 重建默认配置的按钮 |
| `1` | 配置读取失败等可恢复问题 | 可重试，带退避，最多 N 次后停下并展示诊断 |
| 其他非 0 | 未知 | 收集最后 100 行 stderr 落盘，提示「上报」并给出文件路径 |

**`78` 绝不能喂给自动重试**。上游特意用它阻断重启循环，壳若无脑重试，就把它变成「风扇狂转但永远起不来」。

### 3.5 三条明确的「不要」

1. **不要用 `--force`。** 它会杀掉占用目标端口的**任何**进程——可能把用户自己正在跑的 openclaw 杀了。壳应该自己挑空闲端口，而不是抢别人占着的。
2. **不要经 shell spawn。** 走 `sh -c` 会让 SIGTERM 只送到 shell，Gateway 留在后台（上游文档明确警告过这种 wrapper 的后果）。直接 spawn `node`，信号才直达。
3. **不要自己实现单实例锁。** 上游已有 file lock + 进程身份守卫（`docs/gateway/gateway-lock.md`，锁在 `$OPENCLAW_STATE_DIR/tmp/openclaw-<uid>/state.<hash>.lock`）。壳要做的是**认这个锁并翻译它的报错**，不是另造一套。

## 4. 收尾流程

### 4.0 关窗口 ≠ 退出（D026，2026-11-13 修订）

| 动作 | 行为 |
| --- | --- |
| 点窗口关闭按钮 | **只隐藏窗口**。应用与引擎继续跑，驻留托盘 |
| 托盘菜单「退出」 | 走下面的 4.1 收尾流程，真正退出 |
| 系统关机 / 注销 | 视同退出，走 4.1 |

**为什么改**：D014 定了「一天随机时间主动关心一次」。关窗就退出的应用，**在用户关窗那一刻就把主动关心杀死了**——它永远等不到该开口的时候。所以托盘常驻不是体验优化，是 F-主动关心的实现前提。

**由此产生的义务**：托盘图标必须一直在，且「退出」要一眼能找到。用户以为关了、实际还在跑，这是欺骗——不能靠托盘做得隐蔽来回避。

### 4.1 正常退出（托盘退出 / 系统关机）

```text
[1] 挡住新请求，界面进「正在收尾」
[2] SIGTERM 给子进程（不是 SIGKILL）
[3] 等待退出，最长 10s
[4] 仍未退出 → SIGKILL，并在下次启动时提示「上次未能正常退出」
[5] 退出自身
```

**为什么是 10s 而不是上游的数**：上游 `gateway-shutdown-budget.mjs` 的 drain 预算是 **315 秒**（`GATEWAY_SHUTDOWN_DRAIN_TIMEOUT_MS = 315_000`），那是给 systemd / launchd 这类服务监督者留的。桌面应用关窗口等五分钟，用户会以为卡死并强杀——结果更糟。**上游的预算不能照抄，要按交互场景重定。**

### 4.2 异常情况

| 情况 | 处理 |
| --- | --- |
| 引擎自己崩了（非用户退出） | 退避重启（1s / 2s / 4s，上限 3 次）；仍失败则停在「需要诊断」页，不无限重启 |
| 壳崩了但引擎还活着 | 下次启动先探 `/readyz`：通了就接管已有实例（**复用而非重启**）；不通则清理后重启 |
| 状态目录被另一个实例锁着 | 读上游报错，提示「已经有一个在运行」，提供「接管 / 退出」两个选项，**不自动杀进程** |

「壳崩了引擎还在」是这类架构最容易踩的坑，而且**不报错**：用户看不到任何异常，只是下次启动慢、或者起了两个实例抢状态目录。所以启动流程第 3 步之前必须先探一次 `readyz`。

### 4.3 信号

`SIGINT` / `SIGTERM` 会停止进程（上游如此）。但**前提是信号真的送到了 node 进程**——见 §3.5 第 2 条。若壳被 `kill -9`，引擎会成为孤儿；`OPENCLAW_HOME` 指向 app 目录的好处是，下次启动能明确识别「这是我家那个孤儿」，而不是一个来历不明的进程。

**实测补充（2026-11-17）：托盘常驻后，Electron 主进程可能对 `SIGTERM` 无响应。** 开发期清理实例时遇到过一例：`kill -TERM` 后进程（pid 38503）继续存活、端口不释放，最终靠 `kill -9` 收掉。

这不是托盘的 bug，而是「托盘应用对外部信号没有强制退出契约」的固有现象——macOS 上关不掉的是菜单栏应用，Linux 上则取决于窗口是否真的在销毁。**因此开发脚本清理实例时不要只发 SIGTERM 就认为干净了，要「发信号 → 等 → 复查 pid → 不通则 `kill -9`」**，否则下一个实例会撞上单实例锁或状态目录占用，表现为「启动没反应」。

用户层面无需处理（用户走托盘菜单「退出」，那是应用内部路径，已验证可靠）。

### 4.4 托盘四项验收（2026-11-17 实跑记录）

D026 定了四条行为，全部在实机上跑过，不是「代码看起来对」：

| # | 验收项 | 怎么验的 | 结果 |
| --- | --- | --- | --- |
| 1 | 点关闭 → 只隐藏，引擎不退 | CDP 触发 `winClose()`，再查 pid 与端口 | ✅ Electron 存活、引擎继续监听 18890 |
| 2 | 托盘「退出」→ 真退出，无孤儿 | 开发期专用 IPC `devQuit()`（`!app.isPackaged` 才注册） | ✅ Electron 与引擎双双退出、18890 释放、零残留 |
| 3 | 单实例锁：第二次启动叫回原窗口 | 再跑一次启动器，查两处 | ✅ 第二实例退出码 0、原实例存活、`gateway run` 精确 1 个 |
| 4 | 窗口被叫回后可见 | CDP 查 `document.visibilityState` | ✅ `visible` |

**为什么单实例锁是必需项而不是加分项**：托盘常驻后，用户双击图标时应用通常已在跑。没有锁 → 两个 Electron 各 spawn 一个引擎抢同一个状态目录 → 第二个必然失败，且失败方式取决于竞争时序（可能是「配置无效」退出码 78，可能是端口占用），**症状随机，最难排查**。锁必须在 `app.whenReady()` 之前拿。

**`forceQuit` / `before-quit` 的配合是这条路径最容易写反的地方**：

- `close` 事件里若不看 `forceQuit`，`app.quit()` 会被自己的拦截挡回去 → **点了退出没反应**；
- `before-quit` 里若不设 `quitting` 标志，第二次 `app.quit()` 又会进 `preventDefault` → **死循环，退出时卡住**；
- 反过来若 `before-quit` 直接放行（不 stop 引擎）→ **退出把引擎丢成孤儿**，下次启动撞孤儿检测。

三种错法对应三种完全不同的症状，所以这条必须留自动化入口验证，而不是「读一遍觉得对」。该 IPC 只在非打包时注册，发行版里不存在。

## 5. 与已定决策的映射

| 决策 | 落在壳的哪里 |
| --- | --- |
| D017 外挂子进程 | `supervise.ts` 整个文件；`engine/node` + `engine/openclaw` 的打包位置 |
| D019 不改上游 | `engine/` 只读纪律；所有我方代码只在 `extensions/` |
| D020 危机干预走插件 | `extensions/care-guard`；壳只负责把它挂进 `plugins.load.paths` |
| D021 工具面 | `config.ts` 生成 `tools.exec.mode: "allowlist"` + `argv` 白名单 + `sectionOverrides` |
| D011 被记住 | `engine-home/workspace` 必须可见、可备份、卸载不删 |
| D014 主动关心 | **壳不参与调度**，只暴露一个开关（对应 automations 的 enable/disable） |

## 6. 明确不做

- 不在壳里做对话逻辑、情绪判断、危机识别（全在引擎 + 插件侧，D013）
- 不在壳里做调度（D014 的开关只是开关）
- 不缓存会话内容到壳自己的数据库（记忆的唯一事实源是引擎状态）
- 不实现第二套单实例锁

## 7. 动工前的阻塞点：已清零

| 原阻塞 | 现状 |
| --- | --- |
| **O08 私有 Node 从哪来** | **已定**（D023）：随包捆，放 `engine/node/`，绝对路径 spawn + `PATH` 前置；不复制到状态目录 |
| **O09 目录改名** | **已定**（D022）：目录现为 `/home/wuqi/code/hundun-agent-oc` |

**体积基准（2026-11-13 实测）**：引擎运行必需 ≈ **627 MB**（`node_modules` 362 MB + `dist` 265 MB）；Node 24.22.3 单文件 **122 MB**，gzip 后 **42.8 MB**；Electron 45.3.1 的 `dist/` 又是 **274 MB**。

**`engine/docs` 的 23 MB 可以不打包——已查实，不是推测。** 依据 `dist/docs-path-*.mjs` 的 `isUsableDocsDir()`：它只检查 `<packageRoot>/docs/docs.json` 是否存在，不存在就把 `docsPath` 置 `null`；随后 `system-prompt-*.mjs` 的 `docsSection` 在 `docsPath` 为空时**落回 `https://docs.openclaw.ai` 在线地址**，其余提示词照常。也就是说缺 docs 是降级（agent 查文档走线上），不是报错。代价：离线环境下 agent 引不到本地文档。要做就做成打包开关，别默认砍。

**发布流程要写死一条**（D023 承认的债）：**Node 官方发布安全公告时，本 app 必须跟版重发**。用户装完不会自动获得 Node 的安全修复，这条只能靠发版纪律，没有技术兜底。

## 8. 首次跑起来的实测记录（2026-11-13）

这一节记的是「真跑起来之后才知道的事」。凡是本可以事先想到的，不写。

### 8.1 引擎侧（`npm run smoke` 全绿）

```
✓ 引擎就绪，用时 13.3s，pid=45493
✓ /readyz 复查通过
✓ 进程存在：/proc/45493
✓ 收尾完成，用时 942ms
✓ 无孤儿进程
```

- 就绪 13.3s 落在 `STARTUP_TIMEOUT_MS = 90s` 里，余量够。
- 收尾 942ms，远小于自定的 10s 预算（上游 315s 那个预算是给 systemd 的，不用）。
- **修掉的一个真 bug**：只设 `OPENCLAW_HOME` 时引擎报 `Missing config. Run openclaw setup or set gateway.mode=local`。必须同时显式设 `OPENCLAW_STATE_DIR` 与 `OPENCLAW_CONFIG_PATH`（这两个优先级高于 `OPENCLAW_HOME`）。

### 8.2 壳侧：三个坑，全都不是「代码写错了」

| 现象 | 真因 | 处理 |
| --- | --- | --- |
| `Cannot read properties of undefined (reading 'whenReady')`，堆栈显示是 Node v24 在跑 | 宿主 IDE（本身是 Electron 应用）注入 `ELECTRON_RUN_AS_NODE=1`，子进程继承后 Electron 二进制退化成纯 Node，`require("electron")` 只返回一个路径字符串 | `scripts/dev-launch.mjs` 启动前摘掉该变量 |
| `FATAL: The SUID sandbox helper binary was found, but is not configured correctly` | `chrome-sandbox` 需要 root 属主 + 4755，npm 装出来的不具备 | 启动器检测后降级 `--no-sandbox` 并打印修法；**不擅自 sudo** |
| 退出时刷几十行 `Render frame was disposed before WebFrameMain could be accessed` | `before-quit` 里等引擎收尾（约 1s），期间窗口已销毁，日志仍在 `webContents.send` | 统一走 `sendToWindow()`：四重检查 + `shuttingDown` 短路 |

第二条值得记住的是**判断顺序**：看到 FATAL 就想去 `sudo chmod`，其实是绕过了「该不该由构建脚本动系统权限」这个问题。开发期降级、把命令打给用户，比偷偷提权好。

### 8.3 一个自己造的 UI bug（已修）

界面打开后，**最重要的「引擎状态」卡不在视口里**，用户会以为没启动成功。

根因不在 CSS，在 `app.js`：兜底轮询每 3 秒全量重绘 120 行日志，每次 `logs.textContent = ...` 加 `logs.scrollTop = scrollHeight` 都会触发浏览器**滚动锚定**，把外层可滚动的 `<main>` 一起带到底（实测 `main.scrollTop` 从 0 变成 150，第一张卡 `top = -39`）。

修法两条并用：① 日志内容按 `${行数}\0${末行}` 做 diff，没变就不重建 DOM；② 动日志前后保存/恢复 `main.scrollTop`。修后实测 `main.scrollTop = 0`，第一张卡回到 `top = 111`。

教训：**「只是改个子元素的滚动位置」这个假设是错的**，滚动锚定会把影响传到祖先。

### 8.4 一个不是 bug 但要知道的现象

引擎日志里出现：

```
[security] blocked URL fetch (remote-model-catalog) targetOrigin=https://catalog.openclaw.ai
reason=Blocked: resolves to private/internal/special-use IP address
[security] blocked URL fetch (official-external-plugin-catalog-feed) targetOrigin=https://clawhub.ai
```

这是上游的 SSRF 防护在起作用——本机 DNS 把这两个域名解析到了私有/内网地址（网络环境所致，不是配置错）。影响面：**模型目录与插件市场的在线拉取会失败**；不影响已配置凭据的对话。真要接在线目录时得先处理这条，否则会被误判成「代码没写对」。

### 8.5 前端迁移到 Vue（2026-11-17，D025 落地）

**做了什么**：渲染层从手写 HTML/JS 换成 Vue 3，视觉基线整份取自参考项目 `hundunAgent`（奶油白 `#fff8e8` + 朱红 `#c3272b`，左侧窄图标栏，AI 回复不用气泡）。样式前 2040 行是参考项目的 `styles.css` 原样拷入，之后追加 `hx-` 前缀的本项目样式——**前缀是为了将来同步参考项目样式时不撞名**。

**构建为什么要两段**：主进程/preload 继续走 `tsc`（保住严格类型检查），渲染层走 `esbuild + @vue/compiler-sfc`。不用 Vite 的原因不是偏好——参考项目在同一台机器上踩过：Node 虚拟内存受限时 Vite 加载会触发 undici 的 WASM 初始化直接 OOM。esbuild 是原生二进制，`@vue/compiler-sfc` 是纯 JS，都不碰 WASM。

产物：`dist/renderer/assets/app.js` 256 KB（含 Vue runtime）、`app.css` 36 KB。

**实测结果**（`npm run shot` 截图 + CDP 查 DOM）：

- 对话页：`.chat-col` 954×652 可见、`.hx-set` `display:none`、左栏「对话」高亮。
- 设置页：五块内容正常，记忆目录显示 `/home/wuqi/文档/馄饨Agent-OC`。
- 退出：端口释放、引擎退出、`Render frame was disposed` **0 次**（上一轮修的 `sendToWindow` 在新前端上依然有效）。
- Vue 警告 **0 条**。

**一条被实机证实的纪律**：`app.getPath("documents")` 在本机返回的是 **`/home/wuqi/文档`**，不是 `~/Documents`——系统的 XDG 目录名是本地化的。这条实测把 D024 里「不许手拼 `~/Documents`」从推断变成了证据：手拼的代码在这台机器上会直接找不到目录。

**这一版刻意不能对话**：输入框 `disabled`，占位符写「对话还没接上」，页面上明说原因。**不做一个能打字但发不出去的假输入框**——那比不做更让人恼火。

**与 D026 的偏差（已补齐，2026-11-17）**：迁移当时关闭按钮走的还是 `close()` → 退出、不是 `hide()`，因为托盘没做、藏起来就找不回来。托盘实现后两处一起换掉了，验收记录见 §4.4。

### 8.6 一次「假故障」——验证方式自己制造了崩溃（2026-11-17）

这一条记的不是代码，是**方法**。它是本轮最贵的教训。

**现象**：应用启动约 20–50 秒后自行消失，日志以这句话结尾：

```text
[pid] ERROR:content/common/zygote/zygote_communication_linux.cc:313] Failed to send GetTerminationStatus message to zygote
[pid] ERROR:content/browser/network_service_instance_impl.cc:652] Network service crashed or was terminated, restarting service.
[pid] ERROR:content/browser/gpu/gpu_process_host.cc:1038] GPU process launch failed: error_code=1002
[pid] FATAL:content/browser/gpu/gpu_data_manager_impl_private.cc:389] GPU process isn't usable. Goodbye.
```

配合启动时就存在的两条警告（`--ozone-platform=wayland is not compatible with Vulkan`、`vaInitialize failed`），整条序列看上去**铁证如山**：Wayland + Vulkan 不兼容 → GPU 进程崩溃 → Chromium 处决整个应用。对托盘常驻应用来说这是最坏故障，于是加了 `app.disableHardwareAcceleration()`。

**它是错的。** 做了两处对照才发现：

| 变量 | 结果 |
| --- | --- |
| `nohup … &` 起实例 + 不停操作 | 约 20–50s 后必现上面那段 FATAL |
| `nohup … &` 起实例 + 完全闲置 70s | 存活（看似是「被操作」触发） |
| 受管后台任务起实例 + 连打三次截图 | 存活，`FATAL` 计数 0 |
| 同上，**并显式打开硬件加速** | 同样存活，`FATAL` 计数 0、`GPU process launch failed` 计数 0 |

**真正的原因**：`nohup … &` 起的进程仍在工具链的进程树里，调用结束前后被收割。收割顺序恰好是 **zygote 先死**，于是 network service 与 GPU 进程跟着死，Chromium 在「子进程大面积消失」时打出 `GPU process isn't usable`——**这条 FATAL 是结果，不是原因**。症状真实，归因完全错了。

**三条可复用的判断**：

1. **看到「原因」比你预期的时序更整齐时，先怀疑验证装置。** 真正的驱动故障不会每次都精准落在你去戳它的那一刻。
2. **必须做对照实验，而且是关掉嫌疑变量的那一边。** 我一开始只做了「加兜底后还死不死的单边验证」，那是无效验证——单边验证只能证明「某个改动没救活它」，不能证明「原故障与它有关」。
3. **FATAL 里出现「多个不相关子系统同时失败」（zygote + network + GPU），指向外部收割，不指向某个驱动。** 一个子系统坏不会带走另外两个。

**另一个同源的假象**：某次首帧截图里 logo 与头像是破图（`naturalWidth = 0`），刷新后恢复正常。**这条归因现在待定，我原本写在这里的解释很可能是错的。** 原本的推断是命令写法（末尾的 `&` 把整条 `build && launch` 链放进了后台）让页面在资源没拷完时加载；但同一时段 `logo.svg` 本身有个致命缺陷——XML 注释里写了 `--accent` / `--bg` 这种双连字符，整份 SVG 解析失败，`<img>` 静默变断图且控制台无报错——是另一路修好并重建的，所以我那次破图更可能读到的是**修复前的旧资源**。

能当结论用的只有一条：`&` 不要加在整条命令链上，构建与启动必须严格串行。至于破图的真正原因——**XML 注释里不允许出现 `--`**，在 SVG 上尤其阴，因为它不报错、只是静默不渲染。

**结论**：`disableHardwareAcceleration()` 已撤，代码里留了注释说明为什么不能加回去。真实存在的只有一条非致命警告（Wayland 上 Vulkan 不兼容导致合成回退），不影响使用；要治应该去查驱动，不该在壳里永久关 GPU 来掩盖。

## 9. 本文档的边界

这是**设计稿**，不是代码清单。它确定的只有：目录职责、进程怎么起、什么时候算就绪、怎么善终。
它**不确定**：TypeScript 版本、打包工具细节、CI 具体写法、UI 长什么样。这些要等真正动工时再定，现在写等于编。


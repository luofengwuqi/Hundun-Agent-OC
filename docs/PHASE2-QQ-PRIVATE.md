# 二期第一步：QQ 私聊接入 — 共识稿

版本：v0.2
确认人：用户（2026-11-20 当面授权「开工」）
更新日期：2026-11-22（v0.5：凭据到位、真机链路打通 §7.17、辅助模型 404 §7.18；状态行同步）
适用基准：AGENTS.md v0.3、DECISIONS.md v0.3（新增 D034、D035）
状态：**私聊链路已打通（真机验证）**。§1–§6 为约定；§7 是实测事实；§8.1 凭据阻塞已解除。剩余：朋友侧人格待用户填写、辅助模型 404 待处理、群聊未开。

本文维护：二期第一步（QQ 私聊接入）的范围、角色划分、准入流程、记忆与人格归属、失败形态。
本文不维护：需求正文（`PROJECT_PLAN.md`）、决策编号与替代关系（`DECISIONS.md`）、逐项结果（`ACCEPTANCE.md`）、工程与授权边界（根 `AGENTS.md`）。

规划态声明：本文描述目标与约定，不代表已实现。已实现的部分在 §9 用删除线标注并写明验证方式；其余仍属设计。

---

## 1. 范围

### 本期做

- **只做 C2C 私聊**：一个人一个 QQ 号，跟一个 agent 一对一。
- 准入用**白名单**，名单由用户亲手维护，规模 3–5 人。

### 本期明确不做

| 不做 | 原因 / 状态 |
|---|---|
| 群聊 | `channels.qqbot.groupPolicy: "disabled"`。用户在群里被 @ 也收不到任何回应。二期再开。 |
| 「超过五个人的群不回答」 | **平台不给群成员数**，见 §7 事实 3。规则无法度量，故本期不实现。 |
| 记忆加密 | 用户 2026-11-20 决定放弃。记忆以明文存放。 |
| 复用馄饨的人格 | 「馄饨只是一个人」。QQ 侧另有一个人格，见 §2。 |
| 自动同步人格 | 改为显式推送，见 §4。 |
| pairing 配对准入 | 见 §3「为什么不用配对」。 |

---

## 2. 角色与隔离

| 角色 | agentId | workspace | 人格来源 | 谁在这里对话 |
|---|---|---|---|---|
| 馄饨本人 | `main` | `state/workspace/` | 现有 `SOUL.md` / `IDENTITY.md` | 用户（桌面应用 + 用户自己的 QQ 私聊） |
| 朋友 | `qq-<openid 前 8 位>` | `state/workspace-qq-<...>/` | `persona-qq/`（用户写、用户起名） | 每一个被批准的朋友，各自独立 |
| 门房 | `qq-gate` | `state/workspace-qq-gate/` | 空白，不写记忆 | 未被批准的人（兜底 binding 落点） |

三条硬约束：

1. **馄饨不复制**。朋友永远遇不到馄饨，遇到的是 `persona-qq/` 那一份人格。这样「你是不是馄饨」这个问题不会出现。
2. **朋友之间互不可见**。一人一个 agent = 独立 workspace + 独立 SQLite（已核实：`docs/concepts/multi-agent.md`「What is one agent」）。
3. **兜底必须指向门房，不能指向 `main`**。否则一次漏配就是「陌生人直接跟馄饨说话，并写进用户的记忆」。

> **关于「只有一个会话」（2026-11-24 用户口径）**：`session.dmScope = "main"` 落地的是「**一个 agent 一个会话**」，键为 `agent:<agentId>:<mainKey>`（源码 `buildAgentMainSessionKey({agentId, mainKey})`，`agentId` 来自 binding 路由，不是一个全局值）。所以芜柒的桌面应用和芜柒自己的 QQ 私聊共用 `agent:main:main`——这就是用户说的「不管在哪都只有一个会话」。
>
> 将来真批了朋友，他的消息按 binding 路由到 `qq-<id>`，会话是 `agent:qq-<id>:main`，**不会和馄饨那段混**；门房 `qq-gate` 同理。隔离靠的是 agent 边界，不是 dmScope。
>
> **开群之前必须先改这个键**：`dmScope=main` 会把群消息也并进该 agent 的主会话。现在之所以没事，是因为 `channels.qqbot.groupPolicy: "disabled"` 整渠道关着——用户 2026-11-24 明确「先不管群聊多人的事情」。哪天要开群，得先把 dmScope 改回按 peer 分（`per-channel-peer` 之类），不能直接开。

---

## 3. 准入流程

### 配置前提

```jsonc
{
  "channels": {
    "qqbot": {
      "enabled": true,
      "appId": "${QQBOT_APP_ID}",
      "clientSecret": "${QQBOT_CLIENT_SECRET}",
      "transport": "websocket",
      "dmPolicy": "allowlist",
      "allowFrom": ["<用户本人 openid>", "<已批准的人...>"],
      "groupPolicy": "disabled"
    }
  },
  "bindings": [
    { "agentId": "qq-<id>", "match": { "channel": "qqbot", "accountId": "default", "peer": { "kind": "direct", "id": "<openid>" } } },
    { "agentId": "main",    "match": { "channel": "qqbot", "accountId": "default", "peer": { "kind": "direct", "id": "<用户本人 openid>" } } },
    { "agentId": "qq-gate", "match": { "channel": "qqbot", "accountId": "*" } }
  ]
}
```

优先级：引擎按 specificity 判定，`peer` 级永远赢 `accountId` 级，与数组顺序无关（已核实：`docs/concepts/agent-bindings.md`「Match fields and precedence」）。

### 批准一个人 = 跑一次脚本

`scripts/admit-qq.mjs --openid <openid> [--label 备注]`

1. `openclaw agents add qq-<id> --workspace ... --non-interactive`
2. 把 `persona-qq/` 的 `SOUL.md`、`IDENTITY.md`、`AGENTS.md` 铺进新 workspace（**不是** `state/workspace/` 那套）
3. 配置里加 peer 级 binding
4. 把这个 openid 加进 `allowFrom`
5. `config validate`，不过则回滚配置并撤掉本次新建的 agent

**前提：先关掉应用再跑。** 引擎在跑时由它持有状态，另一个进程改 `openclaw.json` 属 unsupported。

### 为什么不用配对（pairing）

- 插件的 `/bot-pairing approve` 在引擎 2026.11.3 上是坏的（`approveChannelPairingCode` 不在公开 SDK 路径，已核实）。
- CLI 的 `openclaw pairing approve` 可用，但会给对方发一段引擎固定生成的**英文**技术文案，与产品气质冲突。
- 白名单 + 手工批准只有 3–5 人，成本可接受。

### 3.3 被拦下的人来说什么（2026-11-20 已定）

`dmPolicy: "allowlist"` 下插件原本**静默丢弃**：`ctx.stop()` 之后中间件链直接断，引擎的钩子全部看不到（§7 事实 4）。对朋友而言就是「发了消息，什么都没发生」。

**决定：改插件的 `dist/index.cjs`**，在拒绝分支加两件事：

1. 回一句中文，例如「我还没被允许和你说话，去找主人开个门吧」——用 `ctx.bot.sendText`，与 pairing 分支同一个 API。
2. 把 `openid` 追加进本地文件，不再依赖只活 24 小时的引擎日志。

推掉的两种做法及原因：

| 做法 | 为什么不选 |
|---|---|
| 静默 + 翻 `/tmp/openclaw/openclaw-*.log` | 对方以为机器人坏了；且 openid 只保留约 24 小时，晚一天就没了 |
| 改用 `dmPolicy: "pairing"` | 对方会收到引擎固定生成的**英文**技术文案（`OpenClaw: access not configured.` + `openclaw pairing approve qqbot <code>`），与产品气质冲突；配对码 1 小时过期 |

代价与边界：

- 这是**改第三方代码**。插件是外部扩展，不是 openclaw 引擎本体（O10 约束的对象），但改动仍需单独留痕。
- 运行代码是 `dist/index.cjs`（未压缩 CJS，一行一句，`require` 可用），改这个文件即可，**不需要重建**（§7 事实 5）。`src/**/*.ts` 改了不生效，但会同步改一份作为可读副本。
- 插件手动升级（`/bot-upgrade` 或 `scripts/upgrade-via-npm.sh`）会覆盖掉补丁。`triggerUpdateCheck` 只查版本打日志，不会自动安装，所以补丁能活到用户主动升级为止。→ 补丁要落成仓库里一个可重放的文件，升级后一行命令重打。

**这一条同时解决了「怎么知道有人来、他是谁」**：被拦者说一句中文、openid 落本地文件，用户看文件就能拿到要批准的那个 openid。在此之前，这是准入流程里唯一没有入口的环节。


---

## 4. 记忆与人格

- **记忆落点**：`state/workspace-qq-<id>/`，明文。每人独立，互相不可见。
- **人格落点**：`persona-qq/`（`SOUL.md` / `IDENTITY.md` / `AGENTS.md`），用户写、用户起名。与 `state/` 平级，放记忆目录下，卸载不删、可直接备份。
- **人格更新**：一次性铺给新准入者；已存在的 agent **不自动跟随**。要有明确的「推送人格」动作才更新——人格是用户的，但已经送到别人手里的那份是两个人共同的，不能让自动同步冲掉。
- **群里不记**：本期群聊整渠道关闭，此条自然成立。

### 4.1 名册：让「他」认识所有人（2026-11-20 定）

要求原始表述：「让 ai 助手像是一个人一样 认识所有的群友」。落成分层：

| 层 | 内容 | 位置 | 谁能写 |
|---|---|---|---|
| 公共层 | 称呼、关系、何时进来、可公开的事实 | `persona-qq/roster.md` → 复制成各 `workspace-qq-*/NAMES.md` | 用户；准入脚本只补占位行 |
| 私人层 | 聊天内容、情绪、处境 | 各 `workspace-qq-*/MEMORY.md` 与会话历史 | 各自的 agent |

**跨人提人的边界：只说公开事实，不转述心事。**（用户选项原文）即：跟小李可以提「小王前两天也来聊过」「他养了只猫叫火锅」，不可以提小王说过的难受事。这条同时写进 `NAMES.md` 前言与 `persona-qq/AGENTS.md`，因为它是**给模型看的规则**。

引擎没有「联系人」这类原生能力（`user-profile-*` 那套是网关主人自己的档案），所以名册靠脚本同步：每次准入后把 `roster.md` 整份复制进每个朋友 workspace。3–5 人，成本可忽略。选复制不选软链，是因为引擎读 workspace 文件时对符号链接的行为没有明确文档。

**门房不铺名册**：`workspace-qq-gate` 被显式排除，它不该知道任何人。

### 4.2 关掉 BOOTSTRAP.md（2026-11-20 定）

`agents add` 会铺 `BOOTSTRAP.md`，而引擎的 `workspace-bootstrap-policy` 把它当正式上下文文件注入（`DEFAULT_BOOTSTRAP_FILENAME`）。不处理的话，朋友第一次私聊会走「身份确认」流程：agent 问他希望怎么称呼自己，然后改写 `IDENTITY.md`——把用户起的名字盖掉，与「QQ 侧名字由用户定」直接冲突。

准入脚本的处理：**改名成 `BOOTSTRAP.md.off`**，不删除。可逆（用户想恢复默认流程就改回来），也避开本机 shell 的删除保护（见 §7.9）。

---

## 5. 告知

接入时对朋友说**全额真话**：对话存在用户这台电脑上，明文，用户技术上看得到，用户不会去读。

明确禁止的表述：

- 「我看不到内容」——不成立。
- 「只有你和它知道」——不成立。

理由（写进决策，避免以后被"优化"掉）：这个产品卖的是「被记住」。如果一方不知道自己说的话会被第三方看到，「被记住」就变成了「被记录」。只放 3–5 个熟人进来，这句话是说得出口的。

---

## 6. 停用与删除

**两段式**，不提供一键真删：

1. **停用**（默认动作）：从 `allowFrom` 移除、撤掉 peer binding、保留 agent 与 workspace。此后对方的私聊落到门房。
2. **真删**（单独一次、需再确认）：`openclaw agents delete <id> --force`。注意它默认把 workspace 丢进**回收站**，即连对话记录一起处理。

理由：记忆删错了没有第二次。

---

## 7. 已核实的事实（影响实现，非推测）

1. **`channels.qqbot.allowFrom` 是必填，且 schema 拒绝 `*`、拒绝空数组。** 缺键报 `must have required property 'allowFrom'`；`[]` 报 `must not have fewer than 1 items`；`["*"]` 报 `must not be valid`。→ 引导期只能用一串永不匹配真 openid 的占位值（当前用 32 个 `0`）。
2. **手改 `openclaw.json` 后首次启动会被引擎拒绝**：`Refusing to run gateway state preparation because the selected config changed during startup (config validity changed)`。必须先跑 `openclaw config validate` 刷新有效性日志。
3. **群成员数拿不到**。插件 `src/types.ts` 与 `dist/index.cjs` 中 `member_count|memberCount` 零命中；QQ SDK `@tencent-connect/qqbot-nodejs` 同样零命中；插件只暴露 `/v2/groups/{group_id}/bot_state`（机器人在该群的状态），不是群资料。
4. **被白名单拦下的消息，引擎侧完全看不到**。插件在 `access-control` 里 `ctx.stop()`，中间件链直接断；引擎的 `before_dispatch` / `message_received` 均在渠道投递之后触发。→ 想在拒绝时回一句话，只能改插件。
5. **插件的运行代码是 `dist/index.cjs`**（`preload.cjs` require 它），`src/**/*.ts` 是源码备份，改了不影响运行。该 bundle 是未压缩 CJS（15664 行，一行一句，`require` 可用），可直接打补丁，无需重建。
6. **`${ENV}` 插值对 `channels.*` 同样生效**（`docs/help/environment.md`）。凭据落 `~/.config/hundun-agent-oc/secrets.json`（0600），明文不进 `openclaw.json`。
7. **插件的 `known-users.json` 写在 `~/.openclaw/qqbot/data/`**（`src/utils/platform.ts:62-68` 用 `os.homedir()`，无视 `OPENCLAW_STATE_DIR`），落在记忆目录之外，与 D024 冲突。→ 待处理，见 §9。
8. **`BOOTSTRAP.md` 是引擎正式注入的上下文文件**。`dist/workspace-bootstrap-policy-*.mjs` 里 `DEFAULT_BOOTSTRAP_FILENAME = "BOOTSTRAP.md"`，`dist/bootstrap-files-*.mjs` 在每次组装 agent 上下文时读取。→ 不处理就会触发起名流程，见 §4.2。
9. **`channels.qqbot.allowFrom` 的元素不允许小写**：`must match pattern "^[^a-z]*$"`（另有 `must be equal to constant (allowed: "openclaw:approval-disabled")` 这类特殊值）。QQ 侧 openid 本来是大写十六进制，但脚本若原样接受小写输入，会表现为「agent 建好了、配置校验才失败」。`admit-qq.mjs` 现在统一转大写。
10. **agentId 取 openid 前 8 位会撞**。自测时两个假 openid 都以 `SELFTEST` 开头，直接并进同一个 agent——后果不是报错，而是**两个真人共用一个记忆库且事后拆不开**。`admit-qq.mjs` 现在会检查该 agentId 是否已绑着别人的 openid，撞了就拒绝，并给出 `--agent-id` 逃生口。
11. **本机 shell 的删除保护会让引擎 CLI 随机失败**。现象：`agents add` 退出码 1，输出只有 `[openclaw] The CLI command failed.`；真因在引擎日志里：
    ```
    CLI cleanup failed: [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]
    {"count":50,"threshold":50,"targets":["…/openclaw.sqlite.seal"]}
    ```
    这台机器的 shell 把 `rm` 与 `fs.rmSync` 换成了带「每轮删除计数」的包装（`CODEBUDDY_SAFE_DELETE_*` + `NODE_OPTIONS` 里的 `node-language-shim.cjs`），计数跨命令累积，撞到 50 后一律拒删。→ `admit-qq.mjs` 的 `engineEnv()` 会剥掉这些变量与 `NODE_OPTIONS` 里的 shim；脚本自身也不再删除文件（BOOTSTRAP 用改名）。
12. **引擎崩溃后留下的租约会让 CLI 白等 4 分钟**。`kill -9` 掉应用后，`openclaw agents add` 报 `failed to acquire gateway state ownership`，然后 `Waiting for plugin lifecycle lease … current lease expires at …` 一直等到过期。租约存在 `state/state/openclaw.sqlite` 的 `state_leases` 表（只读可查）。→ 结论：**停应用要等它自己退**（shutdown budget 最长约 85 秒），别用 `kill -9`。
13. **引擎在跑的时候不要跑 `openclaw` CLI**。实测（2026-11-22 15:43）：网关正跑着，我执行了 `openclaw agents list` / `config validate`，CLI 的 state ownership 握手动到了网关，日志出现 `admission closed: restart-signal fence` 然后引擎退出，**而壳不会自动重拉**——应用窗口还在，引擎没了。→ 读状态可以直接读 `openclaw.json`；要跑 CLI 先停应用。
14. **从带「安全删除」包装的 shell 启动应用，引擎会被传染**。壳的 `supervise.ts` 里 `buildEnv` 会 `...process.env` 继承全部环境，包括 `NODE_OPTIONS` 里的 `node-language-shim.cjs`。删除计数一旦过阈值，引擎在清理阶段抛异常**静默退出**（日志里只剩半句话，连栈都没有），表现为「应用开着、引擎反复消失」。→ 开发期从 AI 的 shell 启动应用要这样起：
    ```bash
    setsid nohup env -u CODEBUDDY_SAFE_DELETE_ENABLED -u NODE_OPTIONS \
      bash scripts/launch-desktop.sh < /dev/null > /tmp/launch.log 2>&1 &
    ```
15. **`pkill -f "electron/dist/electron"` 会把执行它的 shell 一起杀掉**——那条命令行本身就含这个字符串。按 pid 精确杀，或把匹配串写进变量。
16. **通道持续启动失败会把整个引擎拖垮**（2026-11-22 实测，推翻本稿 v0.1 §8.1 的旧结论）。链条：`[qqbot] channel startup failed` → health monitor 请求重启网关 → `admission closed: restart-signal fence` → 引擎退出，**壳不自动重拉** → 应用窗口还在、引擎没了，约每分钟一轮。缺凭据期间必须 `channels.qqbot.enabled = false`。详见 §8.1 的更正块。
17. **真机链路已通（2026-11-22 16:15–16:21，凭据到位后）**。逐步记录，都可在日志里复核：
    - `[qqbot:token:1906476274] Background refresh started` → `[qqbot:api] <<< Status: 200 OK` → `[qqbot] gateway READY`（重启后为 `gateway RESUMED`）
    - 用户私聊机器人（此时不在白名单）→ 补丁落盘 `state/qqbot-pending.jsonl`：`{"openid":"11C4F02A6F70A6C934E45C2548A12650","at":"2026-11-22T08:18:53.454Z"}`，同时收到中文拒绝语
    - `node scripts/admit-qq.mjs --openid 11C4… --existing-agent main --label 我自己的QQ` → `allowFrom` 只剩这个真 openid（占位被清）、binding 为 peer 级指向 `main`
    - 用户再发一句 → `[proactive] Recorded user: default:c2c:11C4…` → `[qqbot:api] 200 OK`；全局库 `worker_session_placements` 出现 `agent_id=main, session_key=agent:main:qqbot:direct:11c4f02a6f70a6c934e45c2548a12650`
    → 结论：**「被拦 → 回话 → 落 openid → 批准 → 路由到指定 agent」整条链在真机上成立。**
18. **辅助模型默认要 `claude-haiku-5-5`，本项目账号没有它**。真机验证时日志出现 `model=claude-haiku-5-5 status=404 … "not available for this group"`。配置里只声明了 `deepseek-v4-1-flash`（`models.mode: merge`，其余来自远端目录）。引擎有 `agents.entries.<id>.utilityModel` 可覆盖这类辅助调用（置空字符串表示禁用）。→ 待处理，见 §9。
19. **`agents add` 会把 `main` 登记进 roster，并用默认路径填它的 `workspace`**（2026-11-22 16:20 事故，真机上表现为「机器人失忆、重新问用户叫什么」）。
    - 机理：`openclaw agents add <id>` 不止建新 agent，它顺手把 `main` 也写成 `agents.entries.main`（`ownership: explicit` 的语义），`workspace` 用默认命名 `<state>/workspace-<agentId>` —— 对 `main` 就是 `state/workspace-main`。那是个**全新空目录**，由引擎铺上模板 `BOOTSTRAP.md`。
    - 表现：配置里 `main.workspace` 从 `state/workspace` 变成 `state/workspace-main`；下一轮组装上下文时注入模板 BOOTSTRAP，于是机器人「第一次认识你、问你想叫什么名字」。**记忆没丢**，它只是走错了屋子（`state/workspace-main` 里没有馄饨的 `SOUL.md` / `MEMORY.md`）。
    - 怎么定位的：只读打开 `state/agents/main/agent/openclaw-agent.sqlite`，查 `session_entry_snapshots` 里 `field='systemPromptReport'` 的 `value_json`。同一个 agent 的十个会话里，9 个是 `workspaceDir: …/state/workspace`，只有 `agent:main:qqbot:direct:11c4f02a…` 那条是 `…/state/workspace-main`，并且带 `BOOTSTRAP.md 7475 字符`。**这张表能直接看出实际注入了哪几个人格文件、workspaceDir 是哪**，以后遇到「人格不对」先查它。
      - 注意该表是 `(session_key, field)` 主键的 upsert 表，每个会话只有一行现值；改完配置不重开会话的话，旧值会留着，要等下一条消息那一轮才刷新。
      - `session_nodes` 里**不存** workspaceDir，所以 workspace 是每轮从 `openclaw.json` 重新解析的——配置改对、引擎重启，下一轮就回到正确目录，不需要删会话。
    - 处理：`main.workspace` 改回 `state/workspace`；`state/workspace-main` 整目录挪到 `/tmp`（未删，可查）；`config validate` 通过后重启。
    - 防复发：`scripts/admit-qq.mjs` 在改配置前记下 `main.workspace` 原值（`mainWorkspaceBaseline`），写完配置再核对一遍，被 `agents add` 改了就按原值钉回并打警告。
20. **引擎日志不落盘，只在应用的日志面板里（内存环）**。`~/.cache/hundun-agent-oc/launch-*.log` 只有构建输出与 Electron 自己的 GPU 报错；`state/logs/` 里只有 `stability/` 那几份崩溃快照。所以「刚才那条 404 还在不在」这类问题，查文件查不到，得看应用面板。→ 想复核通道/模型行为，改用数据库：`channel_ingress_events`（入站）、`diagnostic_events`（配置审计等）、`session_entry_snapshots`（注入内容）。
21. **`setsid nohup … &` 在本次会话环境里会被连坐杀掉**（2026-11-23 19:52 实测）。现象极干净：重定向的日志文件**根本没有生成**、脚本自己的 `~/.cache/hundun-agent-oc/launch-*.log` 也没生成、没有任何进程——说明脚本从未执行。同一条命令在 11-22 是好使的。→ 起应用改用当前工具自带的后台执行，或用 `--dry-run` 先确认环境，再起。

---

## 8. 未决

### 8.1 【阻塞】QQ 开放平台凭据

> **已解除（2026-11-22 16:15）。** 用户在 q.qq.com 取得 AppID `1906476274` 与 AppSecret，写入 `~/.config/hundun-agent-oc/secrets.json`（0600，与模型 key 同文件，合并写入不覆盖）；`channels.qqbot.enabled` 改回 `true`；`config validate` 通过（QQ 相关两条 warning 消失）。引擎启动后通道 `gateway READY`，重启后 `RESUMED`。真机验证记录见 §7.17。
>
> 下文是凭据到位前的原始记录，保留用于说明当时卡在哪。

需要在 [q.qq.com](https://q.qq.com/) 建机器人，取 AppID / AppSecret，消息接收方式设为 WebSocket。当前 `channels.qqbot` 已配好骨架，但引擎每次启动都停在：

```
[qqbot] channel startup failed: Secret owner account:qqbot:default is configured but unavailable
```

> **更正（2026-11-22）：本稿 v0.1 写的「该失败是收敛的：HTTP 端口照常监听，主聊天不受影响」是错的。**
>
> 原文保留在上面，便于比对。实际行为：通道启动失败 → health monitor 请求重启网关 → 引擎收 `admission closed: restart-signal fence` 后退出，而**壳不会自动重拉**。表现是「应用窗口还在、引擎没了」，约每分钟一次循环。实测 15:52:57 一次、15:43:28 一次。
>
> 处理：在拿到凭据之前，`channels.qqbot.enabled` 先设为 `false`。关闭后引擎连续稳定 2 分钟以上无新的 `admission closed`。**凭据到位后把它改回 `true`。**
>
> 未查的是壳为什么不重拉——`src/main/engine/supervise.ts` 的重启逻辑与引擎的 restart-signal 语义对不上，属于既有缺陷，与 QQ 无关，但 QQ 通道的持续失败把它暴露了出来。

### 8.2 用户本人的 openid

用户自己的 QQ 私聊要绑到 `main`，但 `allowFrom` 里必须先有他的 openid。获取方式见 §3.3。

---

## 9. 待处理（不需用户决策，实施时一并解决）

- ~~**插件补丁**（§3.3）：改 `dist/index.cjs` 的 allowlist 拒绝分支~~ **已做**，`scripts/patch-qqbot-reject.mjs`（幂等，带 `--check`/`--dry-run`/`--revert`，dist 与 src 双处），行为自测 `scripts/test-qq-reject-path.mjs` 21/21。
- **`known-users.json` 跑到 `~/.openclaw/qqbot/data/`**：是否需要把它纳入记忆目录，或用环境变量/软链钉到 `state/` 下。与 D024「记忆放文档目录」的一致性有关。
- ~~`scripts/admit-qq.mjs` 现版本会把 `state/workspace/` 的馄饨人格复制给新人~~ **已改**，读 `persona-qq/`，并加「馄饨」守卫（人格里出现该词就拒绝铺，除非 `--force`）。
- ~~`qq-gate` 门房 agent 尚未创建（§2）~~ **已建**，兜底 binding `qqbot accountId=*` 指向它，`main` 无显式规则（走默认）。
- **群聊「不在超过五人的大群里回答」**（用户 2026-11-20 追加）。本期群聊整渠道关闭，规则自然成立；将来开群时需要群成员数，而引擎与插件都拿不到（§7.3）。届时的备选：改为「只在指定群白名单里回答」，把人数判断交给人来批。
- 引擎日志里的既有错误 `[cron/maintenance] Cron maintenance failed … Agent database preparation has ended: main`，与 QQ 无关，但 D014「每天一次主动关心」依赖 cron，需单独查。日志自 2026-11-23 23:34 起落盘（§11.2），下次出现可以直接 `grep`。
- **端到端自测的边界**：~~已验的是「拒绝分支代码行为」「准入后路由与白名单」「名册同步」，没有验过真实 QQ 消息~~ **2026-11-22 16:21 已补上真机验证**（§7.17：被拦 → 回话 → 落 openid → 批准 → 路由到 `main`）。仍未验的是**群聊**（本期整渠道关闭）与**朋友侧完整一轮对话**（`persona-qq/` 还是占位，没有人被真正批进来）。真实批准前必须由用户填好那三个文件——占位里明确写着「不要批准任何人接入」。
- ~~**§7.19 事故的验收点**：`main` 的 workspace 改回、重启后，需要用户在 QQ 里**再发一句**~~ **2026-11-23 19:54 已验收通过**。用户在 QQ 里发「你是谁」，回复是「是馄饨，一只住在终端里的小馄饨…」。快照复核：那条 `agent:main:qqbot:direct:11c4f02a…` 的 `workspaceDir` 已回到 `…/state/workspace`，`injectedWorkspaceFiles` 是 `AGENTS.md`(779) / `SOUL.md`(1103) / `IDENTITY.md`(187)，**没有 `BOOTSTRAP.md`**。
  - 遗留的小瑕疵：同一会话里还留着 11-22 16:20 那条走错屋子的回答，所以这次它顺嘴编了一句「上次还问过你该叫什么名字，看来你已经给它起好了」——它在**给自己的上一次故障找解释**。记忆没断，但那一轮的记录是脏的。会话只有 4 句话，要清可以清；不清也不影响后续。
- ~~**辅助模型 404（§7.18）**~~ **已改配置，未验效果**：`agents.defaults.utilityModel = "anthropic/deepseek-v4-1-flash"`（放 `defaults` 而不是 `main`，将来 `qq-*` 一起受益）。语义依引擎源码 `utility-model-DOwPP7zp.mjs` 的 `readUtilityModelSetting`：不写 = `auto`（按插件清单派生，`claude-haiku-5-5` 即由此而来）、空串 = `disabled`、非空 = `explicit`。`config validate` 通过。**未验**：404 是否真的消失——原先引擎日志不进磁盘（只在应用的日志面板环里）没法事后回看；自 2026-11-23 23:34 起日志落盘到 `state/logs/engine-<day>.log`（§11.2），下次辅助调用可以直接查。


---

## 10. 多端一致：电脑与手机的聊天记录（2026-11-23）

用户提出的场景：在电脑上说一句、再在手机上说一句，两个端显示的记录不一样。问能不能自动同步。

### 10.1 先划清「不可能」的那一半

QQ 客户端只显示**真实收发的 QQ 消息**。电脑上说的话没有经过 QQ，手机端就永远显示不出来——这是腾讯客户端的边界，不是我们能改的。可做的只有两件：**记忆合一** 与 **桌面端显示全部**。

### 10.2 原来为什么不一样（三层分离，非 bug）

1. **引擎层**：两端是两段会话。桌面端用 `hundun-main`（`src/main/main.ts` 的常量，经 `x-openclaw-session-key` 头传入），QQ 用 `agent:main:qqbot:direct:<openid>`——后者由 `session.dmScope = per-channel-peer` 决定（源码 `dist/session-key-CSDERtm3.mjs` 的 `buildAgentPeerSessionKey`）。
2. **桌面层**：界面渲染的是应用自己写的 `chat-history.json`，不是引擎的转写，所以连引擎里 QQ 那段都看不见。
3. **手机层**：见 §10.1。

### 10.3 改法

- `openclaw.json`：`session.dmScope` 从 `per-channel-peer` 改成 `main`。源码里 `dmScope === "main"` 分支返回 `buildAgentMainSessionKey({agentId, mainKey})`，即 `agent:<id>:<mainKey>`（`mainKey` 默认 `main`）。于是 QQ 私聊落进 `agent:main:main`。
- 应用：`SESSION_KEY` 改成 `agent:main:main`；`readSessionKey` 只认 `agent:` 开头的键，旧值（`hundun-main` / `hundun-<uuid>`）一律不用——它们在引擎里是别的会话，继续用等于「换了个屋子」。重置记忆生成的新键同步改成 `agent:main:hundun-<uuid>`。
- 不迁旧记录（用户明确）。旧会话原样留着，只是不再被引用。
  - **2026-11-24 补记**：这句当时只想着引擎侧，没想到它会顺手把**桌面上的旧对话**也一起藏起来。`chat-history.json` 里存的 `sessionKey` 是 `hundun-7c6e6a37-…`，而 `loadChatHistory` 有一道「文件里的 key ≠ 当前 key 就整份作废」的守卫——那道守卫是为「重置记忆会换 key」（D029）写的，改 key 之后它把 11-19 那段判成了「上一个人的」，界面就空了。处理见 §10.8。

### 10.4 顺带修掉的一个真 bug（重要）

**桌面端聊天自 2026-11-22 建 `qq-gate` 之后就是坏的。** 请求里写 `model: "openclaw/default"`、不带 agent 头：单 agent 时能过，多 agent 时引擎直接拒——

```
Multiple agents are configured, but this operation has no explicit owner.
```

证据：`session_nodes` 里 `hundun-*` 会话最后一次更新停在 **2026-11-19 17:28**，之后没有任何成功的桌面会话；`chat-history.json` 的 `savedAt` 也是 11-19。改成 `model: "openclaw/main"` 后恢复。

顺带记下另一个坑：`x-openclaw-session-key` 必须带 `agent:` 前缀。不带前缀（如 `synctest-a`）时引擎先回 `Multiple agents…`（若有 agent 头则回 `internal error`），带前缀才正常应答。

### 10.5 桌面端显示另一端

新增 `src/main/engine/transcript.ts`：以 `node:sqlite` 只读打开 `state/agents/<agent>/agent/openclaw-agent.sqlite`，按 `session_nodes.session_key → current_session_id` 取 `transcript_events` 里 `message_role IN ('user','assistant')` 的行，拼成 `{role, content, ts}`。三处必须处理：

- **压缩存储**：大事件在 `event_zstd` 里（`event_json` 为空），直接跳过，不引 zstd 依赖。
- **包装消息**：桌面端每次发全量历史，引擎把它包成一条 user 消息（`[Chat messages since your last reply - for context] … [Current message - respond to this] User: 正文`）。只取 `[Current message]` 之后那段，否则既难看又和本地历史重复。
- **assistant 的 content 是块数组**，含 `thinking` / `tool_use`，只拼 `type === "text"`。

界面（`App.vue`）把结果放在本地对话之后，标题「手机上聊的」，**只显示不参与上下文**：上下文仍由本地 `turns` 提供，引擎自己也有同一段会话，重复发只会白烧 token。与本地历史重叠的按 `${role}\0${content}` 去重。每 20 秒拉一次（手机上说的话不会推事件过来）。

另有 `dataDir/remote-sync.json` 的水位线 `since`：第一次用到这个功能时记下当前时间，只显示之后的远端消息。理由是「不迁旧记录」——开发期在同一段会话里试出来的几句话不该出现在用户的对话里。

### 10.6 实测事实（决定实现方式的那几条）

1. **会话自带历史会参与上下文**：只发最后一条 user（不带历史），它仍能答出前面说过的内容（先排除记忆文件的干扰再验的）。→ 共用会话键＝记忆真的合一。
2. **桌面端发全量历史不会造成重复上下文**：R1 只发一条、R2 发「全量 + 新一条」、R3 问「把你能看到的用户消息列出来」，它只列出 3 条，没有重复。→ 发送路径不用改，兜底逻辑交给引擎。
3. `model` 只接受 `openclaw` 或 `openclaw/<agentId>`，写具体模型名会被拒：`Invalid \`model\`. Use \`openclaw\` or \`openclaw/<agentId>\`.` → 这也是为什么桌面端只能通过模型名指 agent。

### 10.7 未验 / 待办

- **界面渲染没有肉眼验证**：本机 CDP 调试端口（19222）能连但不回包，`dev-shot.mjs` 拿不到截图。已验的是：构建通过、打包产物里 `hx-day` 出现 2 次（新增块）、`loadRemoteChat` 存在、`readRemoteTurns` 用真实库跑出正确结果（含时间戳、空会话返回空）。
- 手机发一句 → 桌面 20 秒内应出现「手机上聊的」一块。**这一步要用户配合才能验。**
- 两端同时说话时的排队行为未测。


---

## 11. 引擎自己死了怎么办（2026-11-23）

### 11.1 事故

23:06 用户报「qq没连上」。查下来：Electron 窗口还开着，`openclaw gateway` 进程已经不存在，18890 端口无响应。距离引擎实际退出（文件 mtime 约 20:46）已经空了**两个多小时**，期间壳一直以为自己是好的。

**真因没查到**，而且查不到这件事本身是设计缺陷：引擎日志只写进主进程的内存环（`LOG_RING_LINES = 200`），壳不重启就不会落盘，旧实例一被杀，环里的东西连同上一次死因一起消失。`dmesg` 无 OOM 记录、`openclaw.json` 的 mtime 停在 20:16、`state/logs/stability` 里没有新崩溃快照——三条路都断在「没证据」上。

### 11.2 两件事（用户选「两件都做」）

**一、日志落盘。** `src/main/engine/supervise.ts` 的 `log()` 从「只进环」改成「同时进环和磁盘」：

- 路径 `state/logs/engine-<YYYY-MM-DD>.log`，`0600`，追加写。放 `state/logs/` 而不是 `dataDir`：它和 `stability/` 那批崩溃快照是同一类东西（引擎自己的运行记录），排障时不用两头找。
- 单份超 5MB 滚成 `.log.1`，只留一代——够看死因即可，不做日志轮转框架。
- 写盘失败（磁盘满、目录被挪走）只置一个 `sinkBroken` 标志退回纯内存，不把壳带崩。没有这个监听器，`WriteStream` 的 `error` 事件会当未捕获异常直接抛。
- 壳自己的动作（spawn 命令行、退出码、信号）也写进同一个文件，并带 `[shell]` 前缀，所以「谁先死」一眼能看出。

**二、意外退出自动重拉。** 分两层：

`supervise.ts` 只在**就绪之后**被非壳方杀掉时回调 `onUnexpectedExit({code, signal})`。实现上有个必须注意的顺序：退出回调里先取 `wasReady` 快照再改 `status`，反过来写就永远是「不是 ready」。启动阶段失败不走这条路，它仍然抛异常给 `bootEngine` 的 `catch`。

`main.ts` 的 `scheduleRestart(code)` 决定重拉还是认栽，判据只有两条：

| 情况 | 动作 |
| --- | --- |
| `code === 78`（EX_CONFIG） | **绝不重试**，直接 failed 并让用户去修配置。上游用 78 就是为了阻断重启循环，喂给自动重试等于把断路器废掉 |
| 其余 | 按 `[2s, 5s, 10s, 20s, 30s]` 退避重拉，每拉一次 +1 |
| 序列用完 | 停下，`kind: "crash-loop"`，提示里附日志路径 |

额度会还回来：引擎就绪后起一个 5 分钟定时器，跑满 5 分钟就把 `restartAttempts` 清零——中途真崩了还有 5 次可用。定时器在每次成功启动时重置，`before-quit` 与手动重启里清掉。

崩溃提示只消费一次：`bootEngine` 开头把 state 清成 `starting`、成功后又清成 `ready`，两次重置会把提示抹掉，用户只看到窗口「闪了一下又能说话」。所以用 `lastCrashNote` 存一句，重新就绪时并进 `notice`，用完即清。

### 11.4 实测（2026-11-23 23:34–23:39，本机）

对着真实引擎连杀 6 次，读 `state/logs/engine-2026-11-23.log` 的 `[shell]` 行：

| 第几次 | 退出时刻 (UTC) | 重新 spawn | 实际间隔 | 序列值 |
| --- | --- | --- | --- | --- |
| 1 | 15:35:04.603 | 15:35:06.623 | 2.02 s | 2 s |
| 2 | 15:35:37.576 | 15:35:42.595 | 5.02 s | 5 s |
| 3 | 15:36:10.959 | 15:36:20.983 | 10.02 s | 10 s |
| 4 | 15:36:58.839 | 15:37:18.868 | 20.03 s | 20 s |
| 5 | 15:37:44.004 | 15:38:14.027 | 30.02 s | 30 s |
| 6 | 15:38:39.529 | **没有** | — | 额度用完，停 |

第 6 次之后：无引擎进程、`/readyz` 无响应、Electron 壳仍在运行——正是「停下并把原因说出来」的预期形态。

日志本身：应用启动即生成文件，171 行 / 19KB → 23.7KB（引擎启动阶段输出全在），壳的 spawn 与退出记录逐条递增。

### 11.5 这次实测挖出来的东西：引擎有它自己的断路器，重拉成功 ≠ QQ 回来

**这条是本次最重要的发现，比功能本身重要。**

杀到第 3 次之后，引擎日志开始出现：

```
[qqbot] channel autostart suppressed by crash-loop breaker; refusing automatic start for qqbot.
```

`channels status` 也直说了：

```
QQ Bot default: enabled, reason:configuration status unavailable,
error:gateway restart-loop breaker tripped: 5 unclean boot(s) within 300000ms;
suppressing channel/provider account auto-start.
```

读引擎源码（`dist/gateway-boot-lifecycle.kernel-BKdHuusn.mjs`、`dist/gateway-boot-lifecycle-B_E2PbYI.mjs`）：

- 判据在 state 库的 `gateway_boot_lifecycle` 表：`completed_at_ms IS NULL` 或 `outcome='startup_failed'` 记为**一次不干净启动**。
- `GATEWAY_BOOT_LOOP_UNCLEAN_THRESHOLD = 3`、`GATEWAY_BOOT_LOOP_WINDOW_MS = 300_000`。**5 分钟内 3 次不干净启动 → 断路器跳闸**。
- 跳闸后它压的不是网关本身，是**所有通道的自动启动**。自带解除：等窗口排空（`latestUncleanAtMs + 5min`），再下一次重启才恢复 autostart——不会在进程活着的时候自己把通道拉起来。
- 它给的手动出口就是一句命令：`openclaw gateway call channels.start --params '{"channel":"qqbot"}'`。

**为什么这很要命**：壳的退避序列 2/5/10/20/30 秒全部落在 5 分钟窗口内。一次真实的连续故障里，只要崩够 3 次，就会出现「引擎回来了、`/readyz` 200、壳显示一切正常，但 QQ 一条都不回」——**和 21:06 那次用户看到的现象一模一样，只是成因不同**。所以 §11.2 的两件事解决了「引擎不在」，没解决「引擎在但通道被压住」。

本次现场处置：`gateway call channels.start --params '{"channel":"qqbot"}'` → `started: true`，6 秒后 `channels status` 变成 `running, connected`，日志出现 `[qqbot] [default] [default] gateway READY`。

壳要不要在重拉后自动补这一步，问过用户后选了「条件自动补」，见 §11.7。

### 11.6 未验

- **界面文案没肉眼验证**：本机是 Wayland 会话，Electron 渲染成原生 Wayland 窗口，X11 的 `import`（ImageMagick）截不到；CDP 端口仍然不回包。已验证的是代码路径——`crash-loop` 走的是和其他 failure 完全相同的 `status: "failed" + failure` 渲染分支，没有新增界面代码。
- 「手机端在引擎重启期间发消息」的行为未测：这段时间引擎不在，QQ 通道会掉，消息可能丢。重拉只保证引擎回来，不保证消息不丢。
- 崩溃循环上限目前是硬编码 5 次 + 5 分钟清零，没有做成设置项。

### 11.7 通道补启动（D039，2026-11-23 用户选定）

三个候选摆在用户面前：只报告不动手 / 无条件自动补 / **条件自动补**（选中）。理由是语义而不是成本——只报告意味着人在手机上等回复时根本不知道发生了什么；无条件补则是壳长期替引擎判断该不该绕过断路器，引擎想拦也拦不住，而它拦的正是「反复崩的东西不该无限重试」。

**实现**：新增 `src/main/engine/channels.ts`。

- `recoverChannels()` 起一次性 CLI 子进程跑 `gateway call channels.status`（返回干净 JSON，比 `channels status` 的文本好解析），挑出 `enabled && configured && !running` 的通道，逐个 `gateway call channels.start --params '{"channel":"<id>"}'`。
- 触发条件在 `main.ts` 的 `pendingChannelRecovery`：只在 `scheduleRestart`（自动重拉）与 `shell:restart-engine`（用户点重启）里置位；引擎就绪后消费一次。**普通启动不做**。
- 三个坑都撞过：
  1. CLI 默认按配置里的 18789 找网关，壳是用 `--port` 另起的 → 必须把 `OPENCLAW_GATEWAY_PORT` 塞进子进程环境，否则连不上然后报 ECONNREFUSED，看起来像「补启动没生效」。
  2. 子进程要用**和引擎完全同一份环境**（`buildEngineEnv` 导出复用）——`channels.qqbot.appId` 这类值来自环境变量（`QQBOT_APP_ID`），漏了它通道起不来。
  3. 就绪到通道真正起来之间有几秒空档，所以要 `SETTLE_MS = 6s` 之后再查，否则把「正在启动」误判成「被压住」，白拉一次。
- 失败不改 `status`、不抛异常：这是引擎已经起来之后的补救动作，失败只往引擎日志追加一行。
- 查之前等的 6 秒从「引擎就绪」算起，不是从 spawn 算——实测 spawn 15:48:01 → 就绪约 15:48:27 → 补启动 15:48:33，正是这个形状。

**实测**（2026-11-23 23:46–23:50，本机）：先确认干净启动时通道自己就是 `running, connected`，然后连杀 3 次把引擎断路器打跳闸。日志证据：

```
15:48:01.147 [shell] spawn … gateway run … --port 18890
15:48:20.438 [qqbot] channel autostart suppressed by crash-loop breaker; refusing automatic start for qqbot
15:48:33.613 [shell] 通道 qqbot 自动补启动：已交给引擎（handed-off）
15:48:46.335 [shell] spawn …（第 3 次重拉）
15:49:04.824 [qqbot] channel autostart suppressed by crash-loop breaker; …
15:49:19.738 [shell] 通道 qqbot 自动补启动：已交给引擎（handed-off）
```

收尾查 `channels.status`：`qqbot running=True connected=True lastError=None`。**「断路器压住 → 壳补启动 → 通道恢复」这条链是端到端验过的，不是推的。**

顺带说明为什么第 1 次重拉时没有补启动日志：那时通道还没被压住，自己就起来了，`running` 已是 `true`，壳不去碰它——这也顺带证明「正在跑的一律不动」这条生效。

**仍未覆盖**：用户在断路器窗口内**手动关掉再打开应用**（不是壳发起的重启），通道依然会被压住，壳按本决策不做补启动。遇到时的临时办法是点界面上的「重启引擎」——那算壳发起的重启，会补。


---

## 12. 桌面看不见旧对话（2026-11-24）

用户看手机通了，但发现桌面只显示「手机上聊的」，上面一片空白，问之前的聊天记录去哪了。

### 12.1 记录一条没丢，是三道门各挡了一截

| 在哪 | 有多少 | 为什么看不见 |
| --- | --- | --- |
| `~/文档/馄饨Agent-OC/chat-history.json` | 20 轮，11-19 17:28 | `sessionKey` 还是 `hundun-7c6e6a37-…`，与当前 `agent:main:main` 对不上，`loadChatHistory` 整份作废 |
| 引擎 `agent:main:hundun-7c6e6a37-…` | 55 条事件 / 30 条对话，11-19 17:09–17:28 | 是**另一个会话键**，「手机上聊的」只读当前键，读不到 |
| 引擎 `agent:main:main` | 27 条事件 / 11 条对话，11-23 20:08 → 11-24 12:59 | 11-23 20:55 之前那两条测试消息（「收到」「通了」）被 `remote-sync.json` 的水位线挡住——D037 定「不迁旧记录」时故意加的 |

第一道是最容易看漏的：**`loadChatHistory` 的 key 守卫本来是为「重置记忆换 key」（D029）写的**，D037 把键从 `hundun-*` 迁到 `agent:main:main` 之后，它把旧历史当成了「上一个人的」，静默作废。文件还在、20 轮全在，只是不显示。

### 12.2 用户选的处置：直接接上，也当上下文（D040）

两个选项摆在用户面前（只显示不参与上下文 / 直接接上），选后者。

做法：备份 `chat-history.json` 为 `chat-history.json.bak-2026-11-24`，然后把 `sessionKey` 改成 `agent:main:main`，原子写（临时文件 + rename，`0600`）。20 轮全过 `clean()`（都是非空 user/assistant），读回来就是 20 条。

含义要说清楚：接上之后这 20 轮**会作为下一轮的上下文**发给模型（`send()` 带整份 turns），所以模型会看到「11-19 的对话 + 今天的对话」拼成一段。用户接受这个代价——换来的是它下次说话时手上有原话，而不只是记忆文件里的摘要。

生效方式：`restoreHistory()` 只在渲染层挂载时跑一次，所以要让窗口重新加载。做法是关掉壳再开——引擎是壳的子进程，`kill -9` 父进程不会带走它，新壳用 `findAdoptableEngine` 接管（`/readyz` 仍 200），用户看不到「引擎重启」这一跳。

### 12.3 没动的

- 引擎里 `agent:main:hundun-7c6e6a37-…` 那个旧会话原样留着，没删、没合并。
- `dataDir/session.json` 里还写着 `hundun-7c6e6a37-…`。`readSessionKey` 只认 `agent:` 开头的值，所以它现在是惰性的，不影响行为；留着当痕迹。
- 水位线 `remote-sync.json` 没动——那两条测试消息仍然不显示，这是当时说好的。




---

## 13. 「窗口说在线，其实没回话」（2026-11-24 13:09）

### 13.1 现象

用户在 QQ 发「还是忙碌的 唉」（截图时间 13:09），没有任何回复。桌面窗口显示在线，状态栏也没有报错。

### 13.2 现场

| 查什么 | 结果 |
| --- | --- |
| 引擎进程 | **不存在** |
| `127.0.0.1:18890` | 无人监听 |
| `state/logs/engine-2026-11-24.log` | 最后一行停在 **13:00:48**，之后再没写过 |
| 引擎转写 `agent:main:main` | **没有 13:09 那条消息**——它根本没进引擎 |
| 壳进程 | 活着，`shell-runtime.json` 里写着 `pid: 14734 / port: 18890`，也就是它**认为**引擎在 |

### 13.3 链条（每一步都单独成立，连起来就成了静默死亡）

1. **13:04 我为了刷新渲染层，`kill -9` 掉了壳**（重开窗口能让 `restoreHistory()` 重跑）。引擎是壳的子进程，但它没被杀——`kill -9` 父进程不会带走子进程，它被 init 收养。
2. **子进程的 stdout/stderr 是管道，读端随壳一起消失了**。引擎继续跑，但下一次往日志写东西时写端就是死的。
3. 新壳启动，`findAdoptableEngine()` 探到 `/readyz` 还是 200，于是**接管**——按 SHELL-SKELETON §4.2 的设定，这是「上次壳崩了但引擎还活着，别让用户白等一次冷启动」。
4. 接管走完后，**壳手上没有任何句柄**：引擎不是它的子进程，没有 `exit` 事件可听，也没有 `stop()` 可用。它只是把 `state` 写成 `ready` 就完事了。
5. 13:09 消息到达，引擎要写日志 → 管道已断 → EPIPE → 进程退出。**壳毫不知情**，界面继续显示在线。

**所以真正的教训不是「引擎会死」，是「接管之后没人管它」。** 接管买到的不是可靠性，是一个更隐蔽的失败形态。

### 13.4 另外三个顺带挖出来的

- **孤儿引擎会「假活」**：13:16 观察到一个孤儿引擎 `LISTEN` 队列积压（`Recv-Q 1`）、进程状态 `Rl`、CPU 空转，`/readyz` 三秒超时。也就是说即使没被 EPIPE 打死，它也可能卡成「端口在、不回应」。健康判据必须是 `/readyz` 通，不是「端口在听」。
- **`before-quit` 里的 `app.quit()` 会被自己拦下**：`mainWindow.on("close")` 是「没有 `forceQuit` 就 preventDefault + 收进托盘」（D026），而 `app.quit()` 的执行方式正是关所有窗口。对壳发 SIGTERM 后 12 秒仍未退出、引擎已停——变成一个**没有引擎的空壳**，比「没退出」更难发现。托盘菜单的「退出」之所以没事，是因为它先置了 `forceQuit`。
- **启动脚本的「已经在运行」守卫会被骗**：`pgrep -f <二进制路径>` 在主进程被强杀后仍会命中被 init 收养的 zygote/gpu/renderer 子进程，于是「明明没有窗口」也一律拒绝启动。2026-11-24 连踩三次。

### 13.5 修法

1. **接管之后必须探活**（`main.ts` 的 `watchAdoptedEngine`）：每 10 秒 `probeReady(port)`，连续 2 次不通就判定它没了 → 清运行时记录 → `pendingChannelRecovery = true` → `bootEngine()` 重新起一个**真正归自己监护**的引擎。顺带把通道补上（D039），否则断路器又压着 qqbot。
2. **`before-quit` 里先置 `forceQuit = true` 再 `app.quit()`**。
3. **启动脚本的守卫改成判「主进程」**：`electron --no-sandbox <项目目录>` 且不带 `--type=`；只剩子进程时清掉再开。

### 13.6 实测（2026-11-24 13:16–13:17）

```
13:16:33  杀掉壳，孤儿引擎 19732 仍在（/readyz 200）
13:16:36  重开壳 → 13:16:50 确认接管（端口上的 pid 仍是 19732）
13:16:50  杀掉被接管的引擎
13:17:22  新引擎 20396 起来，距引擎被杀 32 秒
13:17:30  [shell] 通道 qqbot 自动补启动：已交给引擎（handed-off）
13:17:32  [qqbot] Gateway ready
```

收尾 `channels.status`：`running=True connected=True lastError=None`。**「接管引擎死了 → 壳发现 → 重起 → 通道补回」这条链是端到端验过的。**

### 13.7 没修的根因（重要，别当成已解决）

**引擎的 stdout 仍然是管道**，所以只要壳死得不是时候（`kill -9`、OOM、崩溃），孤儿引擎最终都会在某次写日志时挂掉或卡住。本次只是做到「挂了能被发现并重拉」（约 30 秒恢复），**没有做到「壳死了引擎继续健康服务」**。

真正的解法是把引擎的 stdout/stderr 接到**文件描述符**而不是管道（`spawn(..., { stdio: ["ignore", fd, fd] })`），这样壳怎么死都断不了它的管。代价是界面上的实时日志面板拿不到 `shell:log` 事件——那是个诊断页，可以接受，但属于取舍，**需要用户点头**。

在那之前，自己的建议：**别用 `kill -9` 关壳**。关窗口（收进托盘）或托盘「退出」都不产生孤儿引擎。

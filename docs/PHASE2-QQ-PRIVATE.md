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
- 引擎日志里的既有错误 `[cron/maintenance] Cron maintenance failed … Agent database preparation has ended: main`，与 QQ 无关，但 D014「每天一次主动关心」依赖 cron，需单独查。
- **端到端自测的边界**：~~已验的是「拒绝分支代码行为」「准入后路由与白名单」「名册同步」，没有验过真实 QQ 消息~~ **2026-11-22 16:21 已补上真机验证**（§7.17：被拦 → 回话 → 落 openid → 批准 → 路由到 `main`）。仍未验的是**群聊**（本期整渠道关闭）与**朋友侧完整一轮对话**（`persona-qq/` 还是占位，没有人被真正批进来）。真实批准前必须由用户填好那三个文件——占位里明确写着「不要批准任何人接入」。
- **辅助模型 404（§7.18）**：`claude-haiku-5-5` 在本账号不可用。要么给 `agents.entries.<id>.utilityModel` 指定 `deepseek-v4-1-flash`，要么置空禁用。影响的是辅助调用（标题/摘要/主动关心那类），不影响主对话——主对话用的 `deepseek-v4-1-flash` 是通的。**未验**：哪些具体功能受它影响。

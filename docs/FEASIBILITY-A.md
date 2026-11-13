# A 方案能力边界验证（零代码二开）

版本：v0.1
更新日期：2026-11-12
适用基准：openclaw 2026.10.10 本地检出（`/home/wuqi/code/openclaw`）
状态：判据材料（非决策）；**未在本机运行验证**，全部为文档级 / 源码级确认
本文维护：治愈系需求到 OpenClaw 现有机制与配置键的映射、能力缺口、环境前提、复核入口
本文不维护：需求正文（`PROJECT_PLAN.md`）、决策与 Q/D/O 编号（`DECISIONS.md`）、逐项验收结果（`ACCEPTANCE.md`）、工程与授权边界（根 `AGENTS.md`）
规划态声明：本文描述目标与实施约定，不代表已实现；文中提及的目录、配置键、插件与能力均不得视为已经存在或已经验证可用。

> 本文的定位是**给 Q001 提供判据**，不是替用户裁决 Q001。凡涉及「建议」，均标注为建议并保留 `[待确认]`。

## 0. 结论

1. **纯 A 层（零代码）能覆盖 10 项需求中的 8 项。** 人格注入、用户模型、记忆检索、主动开口、事件触发、身份形象、微信接入、跨天连续这八块，上游都已做成可配置能力，不需要写 TypeScript。
2. **有 1 项只能部分覆盖**：不打扰的节奏。能按时间段与空闲状态控制，不能按语义条件（关系强度、当日已聊轮次、情绪状态）判断。
3. **有 2 项是硬缺口**：危机干预、情绪状态建模。其中危机干预是唯一一条我认为不能妥协的。
4. 因此 Q001 的现实选项不是「A 还是 B」，而是「A / A + 一个自建安全插件 / B 全面插件化」。**这是建议，D004 未变，Q001 仍为待答。**

需要说清楚的反直觉点：卡住这个项目的不是人格和记忆，这两块上游做得相当完整；卡住的是**安全**——上游对「自伤 / 自杀」没有任何处理逻辑。

## 1. 判定方法

只认三类证据，且三类都给出可复核路径：

- **上游文档**：`docs/` 下对应章节
- **上游源码**：`src/`、`extensions/` 下的实现
- **本机实查**：`which`、`ls`、版本号

**本文所有结论的层级都是「文档 + 源码确认」，不是「运行确认」。** 本机未安装 OpenClaw（见 §5），所以没有任何一条配置键被实际生效验证过。这决定了本文只能当判据，不能当验收。

复核命令：

```bash
# 1. 版本与运行时门槛
grep -A3 '"engines"' /home/wuqi/code/openclaw/package.json

# 2. 人格文件名唯一事实源
grep -n "WORKSPACE_BOOTSTRAP_FILENAMES" /home/wuqi/code/openclaw/src/agents/workspace-bootstrap-policy.ts

# 3. 危机干预是否存在（三处均应为零命中）
grep -rliE "self-harm|suicide" /home/wuqi/code/openclaw/{src,extensions,docs}/
```

## 2. 能覆盖的（8 项）

| 编号 | 需求 | OpenClaw 机制 | 关键配置 / 文件 | 证据 |
| --- | --- | --- | --- | --- |
| R1 | 人格稳定一致 | 会话首轮把工作区人格文件注入系统提示词 | `SOUL.md`、`IDENTITY.md`、`AGENTS.md`；`agents.defaults.bootstrapMaxChars`（默认 20000）、`bootstrapTotalMaxChars`（默认 60000） | `src/agents/workspace-bootstrap-policy.ts`、`docs/gateway/config-agents/workspace-and-bootstrap.md` |
| R2 | 认识这个人 | 专用用户模型文件，按 directive 格式写入稳定偏好 | `USER.md`（**固定 4000 字上限**，配置只能调低不能调高） | `docs/concepts/user-model.md` |
| R3 | 记住聊过的事 | 记忆独占槽 + 检索工具；另有插件做跨会话 Remember | `plugins.slots.memory`（独占，单选）；工具 `memory_search` / `memory_get` | `extensions/memory-core`、`extensions/active-memory` |
| R4 | 主动开口关心 | automation job（原 heartbeat 迁移而来） | 默认每 30 分钟、`idleOnly`、`delivery.target: "owner"`、`activeHours` | `src/cron/default-proactive-job.ts`、`docs/gateway/heartbeat.md` |
| R5 | 事件触发式跟进 | standing intents（前瞻记忆，先关键词预筛，**不调模型**） | 默认 cooldown 24 小时、`maxFires` 3、90 天过期 | `docs/concepts/standing-intents.md` |
| R7 | 形象与身份 | agent 身份字段，缺失时回落到 `IDENTITY.md` | `agents.entries.*.identity`（name / theme / emoji / avatar） | `docs/cli/agents.md` |
| R8 | 从微信说话 | 渠道插件契约 + 腾讯官方外部插件 | `@tencent-weixin/openclaw-weixin`（**仅直聊与媒体，不含群聊**） | `docs/channels/wechat.md` |
| R9 | 换天不断片 | 启动前导注入近期每日记忆 + 根记忆常驻 | `agents.defaults.startupContext`（示例：`dailyMemoryDays: 2`、`maxTotalChars: 2800`）+ `MEMORY.md` | `docs/gateway/config-agents/workspace-and-bootstrap.md` |

> ⚠ **R4 一行的结论已被质疑，不要当定论用。** G02 之后出现两处反向证据：一是用户在 hundunAgent 的 `docs/prd/06-OPENCLAW-PORT.md`「不搬」表里明确否决了「按钟点找你」，理由是这个判据靠提示词劝模型自律；二是本轮 Q006 / D011 说的是「用户**进入程序时**优先安慰」，属 pull 不是 push。冲突已立为 `DECISIONS.md` X01，待裁决。若裁决倾向 pull，R4 应改为「启动即接住」而非 cron 轮询。

R5 有一个对中文很关键、容易踩的机制细节：**中文触发词按字面子串匹配，英文按整词匹配**。原因是 FTS 分词器会把无空格中文整句切成一个 token，所以上游对 CJK 改为直接做子串比对。含义是中文关键词必须写**具体词**（「加班」「复查」「面试」），写宽泛词（「累」「难过」）会到处误触发。另外每轮最多扫描 256 条候选，触发词过多会互相挤占。

## 3. 只能部分覆盖的（1 项）

**R6 不打扰的节奏。**

- 能做的：按时间段限制（`activeHours`，时区感知）、空闲优先（`idleOnly`）、静默返回（`NO_REPLY`）、无变化不投递（`record_result(no_change)`）、空白 checklist 跳过（`payload.skipIfScratchEmpty`）。
- 做不到的：按**语义条件**决定要不要开口。上游没有「今天已主动说过几次」「这个人现在情绪如何」「关系进展到哪一步」这类可查询状态，判断只能交给模型在当次上下文里临场做。
- 附带风险：上游已经**移除了 heartbeat 时期的重复抑制**，原话是 `repeated updates can be delivered`。也就是说主动关心做不好会变成重复打扰，去重要自己加。

## 4. 覆盖不了的（2 项硬缺口）

### G1 危机干预（对应 R10）— 本文最重要的一条

**事实**：`src/`、`extensions/`、`docs/` 三处全量检索 `self-harm|suicide`，**全部零命中**。

**含义**：OpenClaw 有工具权限策略（tool policy / approval，管的是「能不能执行某个动作」），但**没有面向对话内容的安全分类器**（管的是「用户说了什么、该不该换一种回应」）。用户表达自伤意图时，系统不会因此改变任何行为。

**零代码唯一能做的**：在 `SOUL.md` 里写死「识别到 X 时按 Y 应对」。这是**提示词约束，不是机制保障**：

- 漏判就是漏判，没有第二道兜底；
- 长对话里服从性会衰减。上游自己在 `user-model.md` 里引了 PrefEval 的结论——偏好遵循在长对话中显著下降，并因此要求把偏好写成 directive 而非叙述。同一条衰减定律对安全条款同样成立。

**判定：这条不能靠 A 层兜住。** 需要的是一条不走模型的确定性路径，属于 B 层插件：

- 在 `agent_turn_prepare` 或 `before_prompt_build` 注入安全上下文（上游标注为 `promptInjection` 的 hook 仅这三个）；
- 或对入站消息做前置标记，命中即以固定话术 + 本地求助资源回应，不交给模型自由发挥。

**前置条件**：口径与本地求助资源必须由真人确认（Q004），不得由脚手架或 AI 猜。

### G2 情绪状态建模（对应 R10 之外的一条隐含需求）

**事实**：没有情绪变量、状态机或量表。情绪只存在于对话文本里。

**含义**：「今天低落」「这周反复提同一件事」这类跨轮判断，只能靠模型自己在上下文里看，落不成可查询、可累计、可触发告警的状态。

**零代码最接近的替代**：让 agent 把情绪观察写进 `memory/YYYY-MM-DD.md` 日报，靠 `memory_search` 回捞。可接受，但不精确，也无法据此做阈值判断（例如「连续三天下滑」）。

### G3 记忆可遗忘

**事实**：memory-core 只提供 `memory_search`、`memory_get`、`memory_entry_origins`、`memory_session_tombstones`，**没有 forget / 删除单条工具**。`memory_forget` 来自 `memory-lancedb` 插件，不是核心能力。

**含义**：核心记忆层不支持「删掉某一条」，只有会话级 tombstone。

**影响面比看起来大**：如果「用户可以要求遗忘」是产品要求，它会同时决定记忆插件选型；而 memory 是**独占槽**，换插件等于整体迁移。建议在 Q003 / Q006 定稿前先把这条定下来。

## 5. 环境前提（当前不满足，属阻塞而非缺口）

| 项 | 要求 | 本机实测 | 结论 |
| --- | --- | --- | --- |
| Node | `>=24.16.0 <25 \|\| >=26.1.0` | v22.22.2 | **不满足** |
| openclaw | 需安装 | `which openclaw` 无输出；无 `~/.openclaw`；无 `dist/` | **未安装** |
| 上游检出 | 可读、可作开发基线 | 源码完整，但 git 索引为空（约 6.4 万条 staged deletion），`ui/`、`tools/` 目录缺失 | **只可作参考，不可作开发基线** |

Node 门槛来自 `package.json` 的 `engines`，与 `docs/install/node.md` 一致；Node 22、23、25 明确不支持。**这是纯环境问题，装上就跑得动，不是架构问题**；但在装好之前，§2 的每一条都无法从「文档确认」升级为「运行确认」。

## 6. 这对 Q001 意味着什么（建议，不是决策）

> **本节口径已被 G02 部分取代，但结论没变。** G02 之后「A / B / C 三选一」不再是问题——形态已定为 Electron 桌面应用（D005），路线问题转为 Q007（见 `SHAPE-ELECTRON.md`）。下面关于 **G1（危机干预缺口）的结论不随形态改变**：无论外壳怎么做，那个缺口都在引擎层，换前端不会把它补上。保留本节原文，是为了记住「为什么当时认为 A 层不够」。

- 纯 A 能做出一个「人格稳、记得住、会主动开口、能走微信」的原型，作为 MVP 是有价值的，且升级冲突最小。
- 但 G1 决定了这个原型**不能就这样给真实用户用**，尤其当使用者是情绪脆弱人群时。
- 所以真实形态是「A + 一个自建插件」，即 A→B 的**最小切片**，而不是 A 或 B 二选一。
- 建议 Q001 的选项口径改为三选一：**A 纯配置** / **A + 安全插件** / **B 全面插件化**。

再次声明：以上是建议。D004 的有效内容是「暂不替用户拍板」，「A + 安全插件」不构成 Q001 的答案。

## 7. 下一步最小可跑清单（均未授权、未执行）

按顺序，每步都需先取得授权：

1. 装 Node 26（或 24 LTS 线 `>=24.16.0`），确认 `node -v`
2. 安装 openclaw，确认 `openclaw --version`
3. `openclaw agents add companion --workspace <项目内或独立的 workspace 目录>`
4. 写 `SOUL.md` / `IDENTITY.md` / `USER.md` —— **卡在 Q004**
5. 建 automation job，打开 `idleOnly` 与 `activeHours`
6. 装 `@tencent-weixin/openclaw-weixin` 并登录 —— 卡在 Q002
7. 模型凭据与费用上限 —— 卡在 Q003

前三步纯环境、无产品判断，是唯一可以立刻做的一段；第 4 步起全部依赖 Q 清单。

## 8. 证据索引

| # | 结论 | 证据 |
| --- | --- | --- |
| E1 | 人格文件清单的唯一事实源 | `src/agents/workspace-bootstrap-policy.ts`（`WORKSPACE_BOOTSTRAP_FILENAMES`） |
| E2 | 注入预算与开关 | `docs/gateway/config-agents/workspace-and-bootstrap.md` |
| E3 | `USER.md` 4000 字硬上限、directive 格式、与 `MEMORY.md` 分工 | `docs/concepts/user-model.md` |
| E4 | 主动关心默认值、`idleOnly`、`activeHours`、重复抑制已移除 | `docs/gateway/heartbeat.md`、`src/cron/default-proactive-job.ts` |
| E5 | standing intents 的 CJK 子串匹配与默认额度 | `docs/concepts/standing-intents.md` |
| E6 | 身份字段与 `set-identity` | `docs/cli/agents.md` |
| E7 | 微信为腾讯官方外部插件、仅直聊 | `docs/channels/wechat.md` |
| E8 | 危机干预零命中 | §1 复核命令 3 |
| E9 | memory-core 无删除工具 | `extensions/memory-core/src/`（仅四个 `memory_*` 工具） |
| E10 | Node 门槛 | `package.json` `engines`、`docs/install/node.md` |

## 9. 本文未覆盖

- **运行级验证**：全部结论未在本机跑过（§5）。
- **成本与延迟**：主动关心的频率直接决定费用，未估算；依赖 Q003。
- **多用户**：`USER.md` 在多人 Gateway 下按 `users/<profile-id>/USER.md` 补充共享文件，本项目是否触及多用户未定。
- **TTS / 语音**：情绪陪伴可能涉及语音，本文未涉及，属面试录音未定的范围。
- **合规模块**：心理健康类应用的资质与免责表述不在本文范围，需真人判断。

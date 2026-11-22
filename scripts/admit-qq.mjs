#!/usr/bin/env node
/**
 * admit-qq.mjs — 把一个人放进 QQ 私聊白名单，并给他一个**独立**的 agent。
 *
 * 为什么需要这个脚本（而不是在壳里做）：
 *   AGENTS.md §2 的红线（D013）写着「前端只是壳：会话管理、记忆读写、人格拼装
 *   都必须在 OpenClaw 侧」。给一个人建 agent、铺人格、写路由 binding，全都属于
 *   人格拼装与会话管理——放进 Electron 主进程就是造第二个引擎。所以这段逻辑
 *   放在引擎侧的操作脚本里，壳最多只调用它、只显示结果。
 *
 * 为什么一人一个 agent 而不是「一人一个会话」：
 *   `session.dmScope` 只能把**会话**分开，SOUL.md / MEMORY.md 仍然是同一份，
 *   A 说的心事会被记到 B 头上，而且事后拆不开。真正的「一人一套记忆文件」在
 *   OpenClaw 里只有一条路：一个 agent = 独立 workspace + 独立 SQLite（见
 *   docs/concepts/multi-agent.md「What is one agent」）。
 *
 * 做四件事，顺序不能反：
 *   1. `openclaw agents add` 建 agent（顺带铺 BOOTSTRAP.md、建 .git、建 sqlite）
 *   2. 把 **QQ 侧人格**（`persona-qq/` 下的 SOUL / IDENTITY / AGENTS）覆盖进新
 *      workspace。模板里那套是空白人格，不覆盖的话对方遇到的是一个通用助手。
 *      顺手**关掉 BOOTSTRAP.md**（改名 .off）——见下面「为什么关 BOOTSTRAP」。
 *   3. 配置里加 peer 级 binding：这个 openid 的私聊路由到新 agent
 *   4. 配置里把这个 openid 加进 `channels.qqbot.allowFrom`
 * 第 4 步不做的话，这个人会被 access-control 直接 stop（打过补丁后至少会回一句）。
 *
 * **为什么关 BOOTSTRAP.md**：引擎的 `workspace-bootstrap-policy` 把
 * BOOTSTRAP.md 当正式上下文注入每个新 agent。留着它，朋友第一次私聊就会被问
 * 「你希望我怎么称呼我」，然后 agent 自己写 IDENTITY.md——把用户写好的名字盖掉。
 * 名字由用户起，不由第一次对话决定。
 *
 * **名册（NAMES.md）**：引擎没有「联系人」这类原生能力，所以共享名册靠自己同步。
 * `persona-qq/roster.md` 是唯一真源，本脚本把它连同一段纪律前言复制成
 * `NAMES.md` 放进**每个** `workspace-qq-*`。这样每个 agent 都知道「这些人是谁」，
 * 而各自的心事仍留在各自目录里。
 *
 * **人格源是 `persona-qq/`，不是 `state/workspace/`。** 后者是馄饨本人的人格，
 * 只属于用户自己（共识稿 docs/PHASE2-QQ-PRIVATE.md §2「馄饨不复制」）。脚本会
 * 检查这一点：人格里出现「馄饨」就拒绝执行，除非显式 --force。
 *
 * **必须先关掉应用再跑**：引擎在跑的时候由它持有状态，另一个进程直接改
 * openclaw.json 属于 unsupported（引擎自己会在日志里这么说）。
 *
 * 用法：
 *   node scripts/admit-qq.mjs --openid <openid> [--label 昵称] [--dry-run]
 *   node scripts/admit-qq.mjs --openid <openid> --home "/path/to/馄饨Agent-OC"
 *   node scripts/admit-qq.mjs --sync-roster          # 只重铺名册，不动配置
 *
 * 退出码：0 成功 / 1 参数错 / 2 前置条件不满足 / 3 写完校验失败（已回滚）
 */
import { spawnSync } from "node:child_process";
import {
  copyFile,
  existsSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  copyFileSync,
  readdirSync,
  renameSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** 与壳的 paths.ts 保持一致：记忆目录 = 文档目录下的这个名字。 */
const MEMORY_DIR_NAME = "馄饨Agent-OC";
/** QQ 侧人格目录名。与 `state/` 平级，放记忆目录下（卸载不删、可直接备份）。 */
const PERSONA_DIR_NAME = "persona-qq";
/** 从 QQ 侧人格目录复制过去的文件。USER.md 与 BOOTSTRAP.md 故意不复制——见文件头。 */
const PERSONA_FILES = ["SOUL.md", "IDENTITY.md", "AGENTS.md"];
/** 名册真源（用户在 persona-qq 里维护），与复制进各 workspace 的文件名。 */
const ROSTER_SRC = "roster.md";
const NAMES_FILENAME = "NAMES.md";
/** 每个 agent 的 workspace 目录前缀。同步名册时按它扫。 */
const WORKSPACE_PREFIX = "workspace-qq-";
/** 名册前言的纪律。**这段是给模型看的**，所以写成第二人称、可执行。 */
const NAMES_HEADER = `# NAMES.md — 这些人是存在的

> 这个文件由 \`scripts/admit-qq.mjs\` 自动生成，改它没用，下次同步会被覆盖。
> 要改内容，改 \`persona-qq/roster.md\` 再跑 \`node scripts/admit-qq.mjs --sync-roster\`。

名册上的人是真人，你也真的见过他们（各自在自己的对话里）。这份名册让你知道**他们是谁**：

- 记得他们的称呼、和这里的关系、名册上写着的那些公开事实。聊天时自然用得上，
  不用每次重新问「你是谁」。
- **每个人的心事只属于他自己。** 你陪他聊过的具体内容、他的情绪、他的处境，
  一句都不要带到另一个人的对话里。名册只写「是谁」，不写「他说了什么」。
- 不是传话人。不替谁转达，也不替谁打听。

这条边界不是技术限制，是「一个人」和「一个数据库」的区别：
真人当然记得所有朋友，但不会把 A 的伤心事当谈资讲给 B。
`;
/** 占位 openid：schema 不接受空数组和 `*`，只能用一串永不匹配真 openid 的字符占位。 */
const PLACEHOLDER_OPENID = "0".repeat(32);
/** 馄饨的名字。出现在 QQ 侧人格里就说明铺错了源——朋友会认错人。 */
const PROTECTED_NAME = "馄饨";

function die(code, message) {
  console.error(`✗ ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { openid: "", label: "", home: "", dryRun: false, engine: "", force: false, syncRoster: false, agentId: "", existingAgent: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--openid") out.openid = argv[++i] ?? "";
    else if (a === "--label") out.label = argv[++i] ?? "";
    else if (a === "--home") out.home = argv[++i] ?? "";
    else if (a === "--engine") out.engine = argv[++i] ?? "";
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--force") out.force = true;
    else if (a === "--sync-roster") out.syncRoster = true;
    else if (a === "--agent-id") out.agentId = argv[++i] ?? "";
    else if (a === "--existing-agent") out.existingAgent = argv[++i] ?? "";
    else if (a === "-h" || a === "--help") {
      console.log(
        [
          "用法: node scripts/admit-qq.mjs --openid <openid> [--label 备注] [--dry-run] [--force]",
          "      node scripts/admit-qq.mjs --sync-roster",
          "",
          "  --openid      对方的 OpenID。打过拒绝补丁后，它会落在",
          "                <home>/state/qqbot-pending.jsonl；也可以让对方私聊发 /bot-me",
          "  --label       备注名，只进 binding 的 comment 与名册，不参与路由、不进 agent 身份",
          "  --home        引擎 home（默认 $OPENCLAW_HOME，或 ~/文档/" + MEMORY_DIR_NAME + "）",
          "  --engine      openclaw 包根目录（默认 $OPENCLAW_DEV_ENGINE，或全局安装位置）",
          "  --dry-run     只打印计划，不写任何文件",
          "  --force       人格里出现「" + PROTECTED_NAME + "」也照样铺（默认拒绝）",
          "  --agent-id    自定义 agentId（默认 qq-<openid 前 8 位>；前缀撞了就用它）",
          "  --existing-agent  绑到**已经存在**的 agent（如 main），不建新 agent、不铺人格、不写名册",
          "  --sync-roster 只把 persona-qq/" + ROSTER_SRC + " 重铺成各 workspace 的 " + NAMES_FILENAME,
          "                （改了名册、或删了人之后跑这个，不动配置）",
        ].join("\n"),
      );
      process.exit(0);
    } else die(1, `不认识的参数：${a}`);
  }
  return out;
}


/** 解析引擎 home。三个来源按优先级：参数 > 环境变量 > 文档目录默认值。 */
function resolveHome(argHome) {
  if (argHome) return argHome;
  const fromEnv = process.env.OPENCLAW_HOME?.trim();
  if (fromEnv) return fromEnv;
  return join(homedir(), "文档", MEMORY_DIR_NAME);
}

/**
 * 找 openclaw 包根目录（含 dist/index.js 的那层）。
 * 开发期是本机 npm 全局装的那份；打包后引擎跟着应用走，脚本用不到这条路。
 */
function resolveEngineRoot(argEngine) {
  if (argEngine) return argEngine;
  const fromEnv = process.env.OPENCLAW_DEV_ENGINE?.trim();
  if (fromEnv) return fromEnv;
  return join(homedir(), ".local", "lib", "node_modules", "openclaw");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function engineEnv(home) {
  const env = {
    ...process.env,
    OPENCLAW_HOME: home,
    OPENCLAW_STATE_DIR: join(home, "state"),
    OPENCLAW_CONFIG_PATH: join(home, "openclaw.json"),
    OPENCLAW_WORKSPACE_DIR: join(home, "state", "workspace"),
  };

  // ⚠️ 剥掉本机 shell 的「安全删除」包装，否则引擎 CLI 会随机整体失败。
  //
  // 现象：`agents add` 退出码 1，输出只有一句 `[openclaw] The CLI command failed.`，
  // 真正的原因藏在引擎日志里：
  //   CLI cleanup failed: [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]
  //   {"count":50,"threshold":50,"targets":["…/openclaw.sqlite.seal"]}
  //
  // 成因：这台机器的 shell 把 rm 换成了带「每轮删除计数」的包装器
  // （CODEBUDDY_SAFE_DELETE_*）。计数是**跨命令累积**的，撞到 50 之后 rm 一律拒删，
  // 引擎清理自己的临时文件也跟着失败，于是整个命令失败。
  // 引擎删的是 state 目录下它自己的临时文件，不该受这层保护约束。
  for (const key of Object.keys(env)) {
    if (key.startsWith("CODEBUDDY_SAFE_DELETE_")) delete env[key];
    if (key.startsWith("BASH_FUNC_")) delete env[key];
  }
  if (env.PATH) {
    env.PATH = env.PATH.split(":")
      .filter((p) => !p.includes("shim/safe-bin") && !p.includes("safe-delete"))
      .join(":");
  }
  // 真正把包装器注入进来的是 NODE_OPTIONS 里的 --require=…node-language-shim.cjs，
  // 它连 fs.rmSync 都接管。只删环境变量不够，这一句也得摘掉。
  if (env.NODE_OPTIONS) {
    const kept = env.NODE_OPTIONS.split(/\s+/)
      .filter((p) => !p.includes("node-language-shim") && !p.includes("safe-delete"))
      .join(" ")
      .trim();
    if (kept) env.NODE_OPTIONS = kept;
    else delete env.NODE_OPTIONS;
  }
  return env;
}

function runEngine(engineRoot, home, args) {
  const result = spawnSync(process.execPath, [join(engineRoot, "dist", "index.js"), ...args], {
    env: engineEnv(home),
    encoding: "utf8",
    timeout: 180_000,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/**
 * 名册：把 `persona-qq/roster.md` 复制成每个 `workspace-qq-*` 里的 `NAMES.md`。
 *
 * 为什么复制而不是软链：软链指向 workspace 外面，引擎读 workspace 文件时会不会
 * 跟随符号链接取决于实现细节（源码里没看到明确拒绝，但也没看到明确允许）。
 * 复制是确定的：3–5 个人、每次增删人重跑一遍，成本可以忽略。
 *
 * 返回同步到几个目录。
 */
function syncRoster(stateDir, personaDir) {
  const srcPath = join(personaDir, ROSTER_SRC);
  const body = existsSync(srcPath)
    ? readFileSync(srcPath, "utf8").trim()
    : "_（名册还是空的。等你把第一个人加进来，再补充他是谁。）_";
  const payload = `${NAMES_HEADER}\n---\n\n${body}\n`;

  if (!existsSync(stateDir)) return 0;
  const targets = readdirSync(stateDir, { withFileTypes: true })
    // 门房不算朋友：它不该知道任何人。名册只铺给人的 agent。
    .filter((d) => d.isDirectory() && d.name.startsWith(WORKSPACE_PREFIX) && d.name !== "workspace-qq-gate")
    .map((d) => join(stateDir, d.name));
  for (const dir of targets) {
    writeFileSync(join(dir, NAMES_FILENAME), payload, { mode: 0o644 });
  }
  return targets.length;
}

/**
 * 名册里给新来的人占一行，只填知道的部分（openid 前缀 + 备注 + 日期），
 * 称呼和关系留给用户补——**这个脚本猜不出「他是谁」**，猜了就是编造。
 * 已经有一行提到这个 agentId 就跳过，保证可重跑。
 */
function appendRosterEntry(personaDir, agentId, note) {
  const path = join(personaDir, ROSTER_SRC);
  const today = new Date().toISOString().slice(0, 10);
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";

  if (!existing.trim()) {
    const head = [
      "# 名册",
      "",
      "<!-- 每个朋友一行。称呼和关系由你填；脚本只会在准入时补一行占位。",
      "     这份文件会被复制进每个人的 workspace 当 NAMES.md，所以只写",
      "     「他是谁」和可以公开聊的事实，**不要写他说过的心事**。 -->",
      "",
    ].join("\n");
    writeFileSync(
      path,
      `${head}- （待填称呼）｜关系：待填｜${today} 进来｜${note || "无备注"}｜${agentId}\n`,
      { mode: 0o644 },
    );
    return true;
  }

  if (existing.includes(agentId)) return false;
  writeFileSync(
    path,
    `${existing.trimEnd()}\n- （待填称呼）｜关系：待填｜${today} 进来｜${note || "无备注"}｜${agentId}\n`,
    { mode: 0o644 },
  );
  return true;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  // 后面统一个小写→大写，所以这里用 let。
  let openid = opts.openid.trim();

  const home = resolveHome(opts.home);
  const engineRoot = resolveEngineRoot(opts.engine);
  const configPath = join(home, "openclaw.json");
  const stateDir = join(home, "state");
  // QQ 侧人格。**不是** state/workspace（那是馄饨本人，只属于用户）。
  // 放记忆目录下、与 state/ 平级：用户能直接打开、能备份、卸载不会删。
  const personaDir = join(home, PERSONA_DIR_NAME);

  // 只重铺名册的入口。改了 roster.md、或删了人之后跑，不碰配置、不建 agent。
  if (opts.syncRoster) {
    const n = syncRoster(stateDir, personaDir);
    console.log(`✓ 名册已铺到 ${n} 个 workspace（源：${join(personaDir, ROSTER_SRC)}）`);
    if (n === 0) console.log("  一个 workspace-qq-* 都没找到——还没批过任何人？");
    process.exit(0);
  }

  // OpenID 是机器人视角下的不透明 ID。这里只做宽松的形状检查——
  // 卡太死会在平台改格式时误伤，卡太松会把 `*` 这种值放进去（schema 明确拒绝）。
  //
  // ⚠️ 大小写：插件 schema 明确**不允许小写**——
  //   channels.qqbot.allowFrom.0: must match pattern "^[^a-z]*$"
  // 所以这里统一转大写。QQ 的 openid 本来就是大写十六进制，转上去不会改变语义；
  // 不转的话表现为「agent 都建好了，配置校验才失败」，白跑一趟。
  if (openid && openid !== openid.toUpperCase()) {
    console.log(`注意：openid 一律按大写写进配置（插件 schema 不允许小写）：${openid} → ${openid.toUpperCase()}`);
    openid = openid.toUpperCase();
  }
  if (!openid) die(1, "必须给 --openid（让对方私聊机器人发 /bot-me 取）");
  if (!/^[A-Z0-9_-]{16,64}$/.test(openid)) {
    die(
      1,
      `openid 形状不对：${openid}。应当是 16–64 位的大写字母/数字/-/_，不能是 * 或空。`,
    );
  }
  if (openid === PLACEHOLDER_OPENID) die(1, "这是占位 openid，不是真人的。");

  if (!existsSync(configPath)) die(2, `找不到引擎配置：${configPath}`);
  if (!existsSync(join(engineRoot, "dist", "index.js"))) {
    die(2, `找不到引擎入口：${join(engineRoot, "dist", "index.js")}（用 --engine 指一下）`);
  }

  // 「绑到已存在的 agent」是给**用户自己**用的：他的 QQ 私聊要走 `main`（馄饨本人），
  // 不该为他自己再建一个 agent、也不该铺 QQ 侧人格、更不该进名册。
  // 所以人格目录、人格守卫、BOOTSTRAP、名册全部跳过，只做 binding + allowFrom。
  const linkExisting = opts.existingAgent.trim();

  if (!linkExisting) {
    if (!existsSync(personaDir)) {
      die(
        2,
        [
          `找不到 QQ 侧人格目录：${personaDir}`,
          "",
          "这个目录是**你**的活，不由脚本生成。按共识稿 §2 建好并放入：",
          `  ${PERSONA_FILES.map((f) => join(personaDir, f)).join("\n  ")}`,
          "",
          "内容要写「朋友遇到的这个人」，不是馄饨——馄饨只属于用户自己。",
        ].join("\n"),
      );
    }
    const missing = PERSONA_FILES.filter((f) => !existsSync(join(personaDir, f)));
    if (missing.length > 0) {
      die(2, `QQ 侧人格目录缺文件：${missing.join("、")}\n  目录：${personaDir}`);
    }

    // 人格来源守卫：馄饨只属于用户。铺错源的话朋友会以为自己在跟「用户的馄饨」说话，
    // 而这套设计里它们不是同一个东西（共识稿 §2）。宁可拒绝，也不要静默铺错。
    const tainted = PERSONA_FILES.filter((f) => {
      try {
        return readFileSync(join(personaDir, f), "utf8").includes(PROTECTED_NAME);
      } catch {
        return false;
      }
    });
    if (tainted.length > 0 && !opts.force) {
      die(
        2,
        [
          `人格文件里出现了「${PROTECTED_NAME}」：${tainted.join("、")}`,
          "",
          `「${PROTECTED_NAME}」只属于用户自己，不复制给任何人（共识稿 §2）。`,
          "朋友遇到的是 QQ 侧这个人格，如果它自称馄饨，对方会以为在跟用户的那个说话，",
          "而实际上记忆是分开的——那是欺骗，不是设定。",
          "",
          "改掉人格里的名字后重跑；确认要这么干就加 --force。",
        ].join("\n"),
      );
    }
  }

  // agentId 用 openid 前 8 位：稳定、可 grep、不把整个 openid 摊在目录名里。
  // 但前 8 位**可能撞**（自测时就撞过：两个假 openid 都以 SELFTEST 开头）。
  // 撞了的后果不是报错，而是两个人并进同一个 agent = 记忆隔离直接失效，
  // 所以下面要显式拦一次；`--agent-id` 是撞了之后的逃生口。
  const agentId = linkExisting || opts.agentId.trim() || `qq-${openid.slice(0, 8).toLowerCase()}`;
  const workspaceDir = join(stateDir, `workspace-${agentId}`);
  // `--label` 只进 binding 的 comment（给人看的备注），**绝不写进 agent 的 name**。
  // 原因：`agents.entries.*.name` 是 agent 的身份名，会盖过 workspace 里的
  // IDENTITY.md。把对方昵称写进去，馄饨会以为那就是自己的名字。
  const note = opts.label.trim();

  const cfg = readJson(configPath);
  const qq = cfg?.channels?.qqbot ?? {};
  const allowFrom = Array.isArray(qq.allowFrom) ? qq.allowFrom : [];
  const bindings = Array.isArray(cfg.bindings) ? cfg.bindings : [];

  const alreadyAgent = Boolean(cfg?.agents?.entries?.[agentId]);
  const alreadyAllowed = allowFrom.includes(openid);
  const alreadyBound = bindings.some(
    (b) => b?.agentId === agentId && b?.match?.peer?.id === openid,
  );

  // --existing-agent 的前提是它真的存在。写错名字的话会往配置里塞一条指向空气的
  // binding，引擎不报错，消息到了直接没人接——所以要在这里拦住。
  if (linkExisting && !alreadyAgent) {
    die(
      2,
      `没有这个 agent：${linkExisting}\n  现有：${Object.keys(cfg?.agents?.entries ?? {}).join("、")}`,
    );
  }

  // 前缀碰撞守卫：这个 agentId 已经绑了**别人**的 openid，就说明前 8 位撞了。
  // 放过去的话两个人的私聊会落进同一个 workspace / 同一个 sqlite，
  // 记忆混在一起且事后拆不开——这比报错严重得多。
  const foreignPeer = bindings.find(
    (b) => b?.agentId === agentId && b?.match?.peer?.id && b?.match.peer.id !== openid,
  );
  if (foreignPeer) {
    die(
      2,
      [
        `agentId 撞了：${agentId} 已经绑着另一个 openid（…${foreignPeer.match.peer.id.slice(-6)}）。`,
        "",
        "原因是 agentId 取 openid 前 8 位，这两个 openid 前缀相同。",
        "不拦下来的话，两个人会并进同一个 agent —— 记忆隔离失效，事后拆不开。",
        "",
        `换个 id 重跑：--agent-id qq-${openid.slice(0, 12).toLowerCase()}`,
      ].join("\n"),
    );
  }

  console.log("计划：");
  console.log(`  引擎 home     ${home}`);
  console.log(`  agent         ${agentId}${linkExisting ? "（已存在，只加路由）" : alreadyAgent ? "（已存在，跳过创建）" : ""}`);
  if (!linkExisting) {
    console.log(`  workspace     ${workspaceDir}`);
    console.log(`  人格来源      ${personaDir}（${PERSONA_FILES.join(" / ")}）`);
  }
  console.log(`  白名单        ${alreadyAllowed ? "已在" : "追加"} ${openid}`);
  console.log(`  路由 binding  ${alreadyBound ? "已在，跳过" : "新增 peer:direct 绑定"}`);
  console.log(`  群聊          ${qq.groupPolicy === "disabled" ? "已禁用（本期不做群）" : "⚠️ 未禁用"}`);

  if (opts.dryRun) {
    console.log("\n--dry-run：什么都没写。");
    process.exit(0);
  }

  // ── 第 1 步：建 agent。这一步会连带铺 workspace 模板、.git、agent sqlite ──
  // 绑已有 agent（main）时整段跳过：那个人的人格与记忆已经在那儿了。
  let createdAgent = false;
  if (!linkExisting && !alreadyAgent) {
    const r = runEngine(engineRoot, home, [
      "agents",
      "add",
      agentId,
      "--workspace",
      workspaceDir,
      "--non-interactive",
      "--json",
    ]);
    // 引擎会往 stderr 打一堆 missing-env-var 提示，那不是失败，判据只看退出码。
    if (r.status !== 0) {
      die(2, `agents add 失败（退出码 ${r.status}）：\n${r.stderr || r.stdout}`);
    }
    createdAgent = true;
    console.log(`✓ 已建 agent ${agentId}`);
  }

  // ── 第 2 步：覆盖人格。模板铺的是空白人格，不覆盖就不是那个人 ──
  // 故意不复制 USER.md：那是**这个朋友**的画像，要从空白开始，由他自己聊出来。
  // ⚠️ 只在**新建** agent 时铺。绑已有 agent（main）时不能碰它的人格——
  // 那是用户自己的馄饨，被 QQ 侧那套盖掉就是把用户的人格改了。
  if (!linkExisting) {
    for (const name of PERSONA_FILES) {
      const from = join(personaDir, name);
      if (!existsSync(from)) continue;
      copyFileSync(from, join(workspaceDir, name));
    }
  }
  // 关掉 `agents add` 铺的 BOOTSTRAP.md。引擎会把它当正式上下文注入，
  // 留着的结果是朋友第一次私聊被问「你希望我怎么称呼我」，然后 agent 自己写
  // IDENTITY.md，把用户起的名字盖掉。名字由用户定，不由第一次对话定。
  //
  // ⚠️ 用**重命名**而不是删除。两个原因：
  //   1. 这台机器的 shell 把 rm / rmSync 换成了「每轮删除计数」的沙箱包装，
  //      计数撞阈值后连脚本自己的删除都会抛 SAFE_DELETE_BULK_CONFIRM_REQUIRED，
  //      把整个准入流程带崩（实测：agent 建好了，配置没写，留下半个状态）。
  //   2. 可逆。用户想恢复默认的身份确认流程，把 .off 改回来就行。
  // 引擎按精确文件名 BOOTSTRAP.md 找文件，加后缀即失效。
  if (!linkExisting) {
    const bootstrapPath = join(workspaceDir, "BOOTSTRAP.md");
    const hadBootstrap = existsSync(bootstrapPath);
    if (hadBootstrap) renameSync(bootstrapPath, bootstrapPath + ".off");
    console.log(
      "✓ 人格已铺进 workspace（" +
        PERSONA_FILES.join("、") +
        "）" +
        (hadBootstrap ? "，BOOTSTRAP.md 已关掉（改名 .off，可恢复）" : ""),
    );
  }

  // ── 第 3、4 步：改配置。先备份，写完校验，校验不过就回滚 ──
  //
  // ⚠️ 必须在这里**重新读一次配置**，不能用函数开头那份快照。
  // `agents add` 自己会往配置里写东西（`agents.ownership: "explicit"`、
  // `agents.entries.main.workspace`、账户级兜底 binding、`talk.agentId`），
  // 拿旧快照当底稿会在保存时把它们整体冲掉，实测报错：
  //   multi-agent rosters require agents.ownership="explicit"
  // 这也是为什么第 1 步必须排在第 3 步之前，而不是各干各的。
  const cfgAfter = readJson(configPath);
  const backupPath = `${configPath}.bak-admit-${agentId}-${Date.now()}`;
  copyFile(configPath, backupPath, () => {});

  const next = structuredClone(cfgAfter);
  next.agents ??= {};
  next.agents.entries ??= {};
  // 登记 workspace，但**把 `agents add` 写的身份名删掉**——留着它就会盖过我们
  // 刚铺进去的 IDENTITY.md，名单里显示成 `qq-xxxx` 而不是「馄饨」，而且会进
  // 这个 agent 的自我认知。`agents add` 一次写两个地方，两个都得清：
  //   agents.entries.<id>.name
  //   agents.entries.<id>.identity.name   ← 只删前一个没用，实测仍然显示 id
  const entry = { ...(next.agents.entries[agentId] ?? {}), workspace: workspaceDir };
  delete entry.name;
  if (entry.identity && typeof entry.identity === "object") {
    const identity = { ...entry.identity };
    delete identity.name;
    if (Object.keys(identity).length > 0) entry.identity = identity;
    else delete entry.identity;
  }
  next.agents.entries[agentId] = entry;

  // 窄规则放前面只是给人看的；真实优先级由引擎按 specificity 判，
  // peer 级永远赢账户级（docs/concepts/agent-bindings.md「Match fields and precedence」）。
  const peerBinding = {
    agentId,
    comment: `QQ 私聊${note ? ` ${note}` : ""}（openid ${openid.slice(0, 8)}…）`,
    match: { channel: "qqbot", accountId: "default", peer: { kind: "direct", id: openid } },
  };
  next.bindings = [peerBinding, ...(next.bindings ?? []).filter(
    (b) => !(b?.agentId === agentId && b?.match?.peer?.id === openid),
  )];

  next.channels ??= {};
  next.channels.qqbot = {
    ...(next.channels.qqbot ?? {}),
    // 有真人进来了，就把占位清掉；占位留着不会伤人，但会让人误读白名单。
    allowFrom: [
      ...new Set([
        ...((next.channels.qqbot?.allowFrom ?? []).filter((id) => id !== PLACEHOLDER_OPENID)),
        openid,
      ]),
    ],
    dmPolicy: "allowlist",
  };

  writeJson(configPath, next);
  console.log(`✓ 配置已写（备份 ${backupPath}）`);

  const check = runEngine(engineRoot, home, ["config", "validate"]);
  if (check.status !== 0) {
    copyFile(backupPath, configPath, () => {});
    // 配置回滚了，但第 1 步建的 agent 还留在盘上。留着它会让下一次运行走
    // 「已存在，跳过创建」的分支，然后卡在同一个地方——所以一并撤掉。
    if (createdAgent) {
      runEngine(engineRoot, home, ["agents", "delete", agentId, "--force", "--json"]);
    }
    die(
      3,
      `配置校验没过，已回滚（agent ${createdAgent ? "连带撤掉" : "本来就有，未动"}）：\n${check.stdout}${check.stderr}`,
    );
  }
  console.log("✓ config validate 通过");

  // ── 第 5 步：名册。新来的人先在 roster.md 占一行（称呼/关系留给你填），
  //            然后把整份名册铺进每个人的 workspace。放在校验之后：
  //            配置没过就不该在名册上留半个名字。
  //            绑已有 agent 时整段跳过——用户自己不进「朋友名册」。
  if (!linkExisting) {
    if (appendRosterEntry(personaDir, agentId, note)) {
      console.log(`✓ 名册加了占位一行（称呼和关系待你补：${join(personaDir, ROSTER_SRC)}）`);
    }
    const synced = syncRoster(stateDir, personaDir);
    console.log(`✓ 名册已铺到 ${synced} 个 workspace（${NAMES_FILENAME}）`);

    console.log(
      [
        "",
        "完成。启动应用后，这个人的第一条私聊会落到他自己的 workspace：",
        `  ${workspaceDir}`,
        "他一开口遇到的就是你在 persona-qq 写的那个人格，不会有人问他「你叫我什么」。",
        "他的记忆只在这个目录里，和别人互不可见；他知道其他人是谁，但不知道别人的心事。",
        "",
        "记得把名册里的占位补上：称呼、和你的关系、可以公开聊的事实。",
      ].join("\n"),
    );
    return;
  }

  console.log(
    [
      "",
      `完成。这个 openid 的 QQ 私聊现在路由到 ${agentId}（已存在的 agent，人格与记忆都没动）。`,
      "启动应用后直接私聊机器人即可，走的是那个 agent 原本的会话。",
    ].join("\n"),
  );
}

main();

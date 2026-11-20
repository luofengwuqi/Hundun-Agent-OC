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
 *   2. 把主人格（SOUL / IDENTITY / AGENTS）覆盖进新 workspace——模板里那套是
 *      空白人格，不覆盖的话每个人遇到的都不是「馄饨」
 *   3. 配置里加 peer 级 binding：这个 openid 的私聊路由到新 agent
 *   4. 配置里把这个 openid 加进 `channels.qqbot.allowFrom`
 * 第 4 步不做的话，这个人会被 access-control 直接 stop，连「没权限」都不回。
 *
 * **必须先关掉应用再跑**：引擎在跑的时候由它持有状态，另一个进程直接改
 * openclaw.json 属于 unsupported（引擎自己会在日志里这么说）。
 *
 * 用法：
 *   node scripts/admit-qq.mjs --openid <openid> [--label 昵称] [--dry-run]
 *   node scripts/admit-qq.mjs --openid <openid> --home "/path/to/馄饨Agent-OC"
 *
 * 退出码：0 成功 / 1 参数错 / 2 前置条件不满足 / 3 写完校验失败（已回滚）
 */
import { spawnSync } from "node:child_process";
import { copyFile, existsSync, readFileSync, writeFileSync, chmodSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** 与壳的 paths.ts 保持一致：记忆目录 = 文档目录下的这个名字。 */
const MEMORY_DIR_NAME = "馄饨Agent-OC";
/** 从主人格 workspace 复制过去的文件。USER.md 与 BOOTSTRAP.md 故意不复制——见文件头。 */
const PERSONA_FILES = ["SOUL.md", "IDENTITY.md", "AGENTS.md"];
/** 占位 openid：schema 不接受空数组和 `*`，只能用一串永不匹配真 openid 的字符占位。 */
const PLACEHOLDER_OPENID = "0".repeat(32);

function die(code, message) {
  console.error(`✗ ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { openid: "", label: "", home: "", dryRun: false, engine: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--openid") out.openid = argv[++i] ?? "";
    else if (a === "--label") out.label = argv[++i] ?? "";
    else if (a === "--home") out.home = argv[++i] ?? "";
    else if (a === "--engine") out.engine = argv[++i] ?? "";
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "-h" || a === "--help") {
      console.log(
        [
          "用法: node scripts/admit-qq.mjs --openid <openid> [--label 昵称] [--dry-run]",
          "",
          "  --openid   对方在机器人视角下的 OpenID（让他私聊机器人发 /bot-me 就能看到）",
          "  --label    备注名，只用于显示，不参与路由",
          "  --home     引擎 home（默认 $OPENCLAW_HOME，或 ~/文档/" + MEMORY_DIR_NAME + "）",
          "  --engine   openclaw 包根目录（默认 $OPENCLAW_DEV_ENGINE，或全局安装位置）",
          "  --dry-run  只打印计划，不写任何文件",
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
  return {
    ...process.env,
    OPENCLAW_HOME: home,
    OPENCLAW_STATE_DIR: join(home, "state"),
    OPENCLAW_CONFIG_PATH: join(home, "openclaw.json"),
    OPENCLAW_WORKSPACE_DIR: join(home, "state", "workspace"),
  };
}

function runEngine(engineRoot, home, args) {
  const result = spawnSync(process.execPath, [join(engineRoot, "dist", "index.js"), ...args], {
    env: engineEnv(home),
    encoding: "utf8",
    timeout: 180_000,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const openid = opts.openid.trim();

  // OpenID 是机器人视角下的不透明 ID。这里只做宽松的形状检查——
  // 卡太死会在平台改格式时误伤，卡太松会把 `*` 这种值放进去（schema 明确拒绝）。
  if (!openid) die(1, "必须给 --openid（让对方私聊机器人发 /bot-me 取）");
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(openid)) {
    die(1, `openid 形状不对：${openid}。应当是 16–64 位的字母数字/-/_，不能是 * 或空。`);
  }
  if (openid === PLACEHOLDER_OPENID) die(1, "这是占位 openid，不是真人的。");

  const home = resolveHome(opts.home);
  const engineRoot = resolveEngineRoot(opts.engine);
  const configPath = join(home, "openclaw.json");
  const stateDir = join(home, "state");
  const personaDir = join(stateDir, "workspace");

  if (!existsSync(configPath)) die(2, `找不到引擎配置：${configPath}`);
  if (!existsSync(join(engineRoot, "dist", "index.js"))) {
    die(2, `找不到引擎入口：${join(engineRoot, "dist", "index.js")}（用 --engine 指一下）`);
  }
  if (!existsSync(join(personaDir, "SOUL.md"))) {
    die(2, `找不到主人格：${join(personaDir, "SOUL.md")}（应用至少启动过一次才有）`);
  }

  // agentId 用 openid 前 8 位：稳定、可 grep、不把整个 openid 摊在目录名里。
  const agentId = `qq-${openid.slice(0, 8).toLowerCase()}`;
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

  console.log("计划：");
  console.log(`  引擎 home     ${home}`);
  console.log(`  agent         ${agentId}${alreadyAgent ? "（已存在，跳过创建）" : ""}`);
  console.log(`  workspace     ${workspaceDir}`);
  console.log(`  人格来源      ${personaDir}（${PERSONA_FILES.join(" / ")}）`);
  console.log(`  白名单        ${alreadyAllowed ? "已在" : "追加"} ${openid}`);
  console.log(`  路由 binding  ${alreadyBound ? "已在，跳过" : "新增 peer:direct 绑定"}`);
  console.log(`  群聊          ${qq.groupPolicy === "disabled" ? "已禁用（本期不做群）" : "⚠️ 未禁用"}`);

  if (opts.dryRun) {
    console.log("\n--dry-run：什么都没写。");
    process.exit(0);
  }

  // ── 第 1 步：建 agent。这一步会连带铺 workspace 模板、.git、agent sqlite ──
  let createdAgent = false;
  if (!alreadyAgent) {
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

  // ── 第 2 步：覆盖人格。模板铺的是空白人格，不覆盖就不是馄饨 ──
  // 故意不复制 USER.md（那是**这个人**的画像，要从空白开始）和
  // BOOTSTRAP.md（模板留着，第一次对话就是「初次见面」那场）。
  for (const name of PERSONA_FILES) {
    const from = join(personaDir, name);
    if (!existsSync(from)) continue;
    copyFileSync(from, join(workspaceDir, name));
  }
  console.log(`✓ 人格已铺进 workspace（${PERSONA_FILES.join("、")}）`);

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

  console.log(
    [
      "",
      "完成。启动应用后，这个人的第一条私聊会落到他自己的 workspace：",
      `  ${workspaceDir}`,
      "第一次对话是空的 BOOTSTRAP.md 触发——他会先问怎么称呼、是不是第一次认识。",
      "他的记忆只在这个目录里，和别人互不可见。",
    ].join("\n"),
  );
}

main();

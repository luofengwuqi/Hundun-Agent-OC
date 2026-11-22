#!/usr/bin/env node
/**
 * patch-qqbot-reject.mjs — 给 QQ 插件的「拒绝」分支补两件事
 *
 * 为什么需要（共识稿 `docs/PHASE2-QQ-PRIVATE.md` §3.3）：
 *   白名单模式（dmPolicy=allowlist）下，插件对未被批准的人做的是
 *   `ctx.stop("access:not_allowlisted")`——中间件链直接断，引擎的钩子
 *   （before_dispatch / message_received）全在渠道投递之后才触发，
 *   所以被拦的消息**连引擎都到不了**。结果是：对方屏幕毫无反应，
 *   以为机器人坏了；而他的 openid 只落在 /tmp/openclaw/ 的日志里，
 *   保留约 24 小时——晚一天去查就没了。
 *
 *   这个补丁在拒绝分支里加两件事：
 *     1. 回一句中文（`ctx.bot.sendText`，与 pairing 分支同一个 API）
 *     2. 把 openid 追加进 `<OPENCLAW_STATE_DIR>/qqbot-pending.jsonl`（去重）
 *   §3.3 里定的就是这样：让对方知道发生了什么，让主人知道谁来过。
 *
 * 为什么改 dist 而不是 src：
 *   运行时只跑 `dist/index.cjs`（`preload.cjs` require 它），`src` 下的 .ts
 *   是源码备份，改了不生效。dist 是未压缩 CJS（一行一句、`require` 可用），
 *   可以直接插代码，**不需要装 tsup 重建**。src 同步改一份是给人读的。
 *
 * 会被什么冲掉：
 *   插件手动升级（`/bot-upgrade` 或 `scripts/upgrade-via-npm.sh`）会覆盖 dist。
 *   `triggerUpdateCheck` 只查版本打日志、不会自动装，所以补丁能活到你主动升级
 *   为止。升级之后重跑本脚本即可（幂等）。
 *
 * 用法：
 *   node scripts/patch-qqbot-reject.mjs [--dry-run] [--revert] [--plugin <dir>]
 *   node scripts/patch-qqbot-reject.mjs --check        # 只报告当前是否已打
 *
 * 退出码：0 成功（或无事可做）/ 1 参数或前置条件错 / 2 打完语法校验失败（已回滚）
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MEMORY_DIR_NAME = "馄饨Agent-OC";
/** 幂等标记：在补丁前后各留一个，用来判断「已经打过」。 */
const MARKER = "/*__hundun:qq-reject-patch__*/";
/** 补丁的插入锚点，必须是唯一的。 */
const ANCHOR = 'ctx.stop("access:not_allowlisted");';
/** 回给对方的话。刻意不提任何名字——这时我们还不知道对面的 agent 叫什么。 */
const REPLY_TEXT = "我暂时还不能和你说话。需要先被允许——去跟把我接进来的人说一声吧。";

/**
 * 插进 dist/index.cjs 的代码。
 *
 * 作用域保证：插入点在 `dynamicAccessControl` 返回的 async 箭头函数内部，
 * 同层已存在 `ctx`、`isGroup`、`id`（见插件源码 access-control.ts:52/71），
 * 所以这里可以直接引用；`await` 也合法，因为那个箭头函数是 async 的。
 * `require` 在 CJS bundle 的模块作用域里可用（bundle 自己用了 20 次）。
 */
const INJECT = `${MARKER}
    if (!isGroup) {
      try {
        const __hunFs = require("node:fs");
        const __hunPath = require("node:path");
        const __hunOs = require("node:os");
        const __hunDir = process.env.OPENCLAW_STATE_DIR || __hunPath.join(__hunOs.homedir(), ".openclaw");
        const __hunFile = __hunPath.join(__hunDir, "qqbot-pending.jsonl");
        const __hunSeen = __hunFs.existsSync(__hunFile) ? __hunFs.readFileSync(__hunFile, "utf8") : "";
        if (!__hunSeen.includes(id)) {
          __hunFs.appendFileSync(__hunFile, JSON.stringify({ openid: id, at: new Date().toISOString() }) + "\\n", { mode: 0o600 });
        }
      } catch (__hunErr) {
        ctx.log?.warn?.("[access] pending-openid 落盘失败: " + (__hunErr && __hunErr.message));
      }
      try {
        await ctx.bot.sendText(ctx.replyTarget, ${JSON.stringify(REPLY_TEXT)});
      } catch (__hunErr2) {
        ctx.log?.warn?.("[access] 拒绝回话发送失败: " + (__hunErr2 && __hunErr2.message));
      }
    }
`;

function die(code, message) {
  console.error(`✗ ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { dryRun: false, revert: false, check: false, plugin: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--revert") out.revert = true;
    else if (a === "--check") out.check = true;
    else if (a === "--plugin") out.plugin = argv[++i] ?? "";
    else if (a === "-h" || a === "--help") {
      console.log(
        [
          "用法: node scripts/patch-qqbot-reject.mjs [--dry-run] [--revert] [--check] [--plugin <dir>]",
          "",
          "  --dry-run   只报告将要做什么，不写文件",
          "  --revert    从 .orig-hundun 备份恢复（撤销补丁）",
          "  --check     只报告当前是否已打补丁",
          "  --plugin    插件目录（默认 $OPENCLAW_HOME/state/extensions/openclaw-qqbot）",
        ].join("\n"),
      );
      process.exit(0);
    } else die(1, `不认识的参数：${a}`);
  }
  return out;
}

function resolvePluginDir(argPlugin) {
  if (argPlugin) return argPlugin;
  const home = process.env.OPENCLAW_HOME?.trim() || join(homedir(), "文档", MEMORY_DIR_NAME);
  return join(home, "state", "extensions", "openclaw-qqbot");
}

/** 用 node --check 真解析一遍：bundle 语法坏了会让整个插件在 require 时炸，
 *  而那一步发生在 gateway 启动过程中，用户只会看到「应用打不开」。 */
function syntaxOk(file) {
  const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  return { ok: r.status === 0, message: (r.stderr || r.stdout || "").trim() };
}

/**
 * 同步改 src 里的可读副本。
 *
 * 改坏了不影响运行（运行的是 dist），所以失败只警告、不回滚。
 * 这里不做 「调一个 helper」 的花样：直接内联同样的逻辑，让这份副本
 * 单独看也能读懂当时到底做了什么。
 */
function syncSrc(srcPath) {
  if (!existsSync(srcPath)) {
    console.log("⚠ 找不到 src 副本，跳过（运行代码不受影响）");
    return;
  }
  const tsAnchor = "ctx.stop('access:not_allowlisted');";
  const ts = readFileSync(srcPath, "utf8");
  if (ts.includes(MARKER)) {
    console.log("✓ src 副本已有标记，跳过");
    return;
  }
  const hits = ts.split(tsAnchor).length - 1;
  if (hits !== 1) {
    console.log(`⚠ src 副本的锚点出现 ${hits} 次（要求 1 次），跳过（运行代码不受影响）`);
    return;
  }
  const tsInject = `    ${MARKER}
    if (!isGroup) {
      try {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const os = await import('node:os');
        const dir = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), '.openclaw');
        const file = path.join(dir, 'qqbot-pending.jsonl');
        const seen = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
        if (!seen.includes(id)) {
          fs.appendFileSync(file, JSON.stringify({ openid: id, at: new Date().toISOString() }) + '\\n', { mode: 0o600 });
        }
      } catch (err) {
        ctx.log?.warn?.('[access] pending-openid 落盘失败: ' + (err as Error).message);
      }
      try {
        await ctx.bot.sendText(ctx.replyTarget, ${JSON.stringify(REPLY_TEXT)});
      } catch (err) {
        ctx.log?.warn?.('[access] 拒绝回话发送失败: ' + (err as Error).message);
      }
    }
`;
  writeFileSync(srcPath, ts.replace(tsAnchor, `${tsInject}    ${tsAnchor}`));
  console.log("✓ src 副本已同步（不参与运行，仅供阅读）");
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const pluginDir = resolvePluginDir(opts.plugin);
  const distPath = join(pluginDir, "dist", "index.cjs");
  const backupPath = `${distPath}.orig-hundun`;
  const srcPath = join(pluginDir, "src", "middleware", "access-control.ts");

  if (!existsSync(distPath)) die(1, `找不到插件运行代码：${distPath}（用 --plugin 指一下插件目录）`);

  const current = readFileSync(distPath, "utf8");
  const patched = current.includes(MARKER);

  if (opts.check) {
    console.log(`插件目录  ${pluginDir}`);
    console.log(`补丁状态  ${patched ? "已打" : "未打"}`);
    console.log(`备份      ${existsSync(backupPath) ? "有（" + backupPath + "）" : "无"}`);
    process.exit(0);
  }

  if (opts.revert) {
    if (!existsSync(backupPath)) die(1, `没有备份可恢复：${backupPath}`);
    if (opts.dryRun) {
      console.log(`[dry-run] 会用 ${backupPath} 覆盖 ${distPath}`);
      process.exit(0);
    }
    copyFileSync(backupPath, distPath);
    const v = syntaxOk(distPath);
    if (!v.ok) die(2, `恢复后语法校验没过（不该发生）：\n${v.message}`);
    console.log("✓ 已从备份恢复，补丁撤销");
    process.exit(0);
  }

  if (patched) {
    console.log("✓ 补丁已在，无需重复打（幂等）");
    console.log(`  备份 ${existsSync(backupPath) ? backupPath : "无（说明之前是别的途径打的）"}`);
    // dist 已经是好的，但 src 副本可能是上一次失败留下的半成品——单独补一次。
    syncSrc(srcPath);
    process.exit(0);
  }

  // 锚点必须唯一：出现 0 次说明插件版本变了，出现 >1 次说明插错位置的风险太高。
  const hits = current.split(ANCHOR).length - 1;
  if (hits !== 1) {
    die(1, `锚点出现 ${hits} 次（要求正好 1 次）。插件可能已升级或结构变了，别硬打，先人工看一眼：\n  ${distPath}`);
  }

  // 插入点：锚点所在行之前，并把原行保留。
  const next = current.replace(ANCHOR, `${INJECT}    ${ANCHOR}`);

  console.log("计划：");
  console.log(`  插件目录   ${pluginDir}`);
  console.log(`  目标       dist/index.cjs（未压缩 CJS，运行时实际加载的那份）`);
  console.log(`  动作       在 ${ANCHOR} 之前插入：回一句中文 + openid 落 qqbot-pending.jsonl`);
  console.log(`  备份       ${backupPath}${existsSync(backupPath) ? "（已存在，保留最早那份）" : ""}`);
  console.log(`  同步改     src/middleware/access-control.ts（可读副本，不参与运行）`);
  console.log(`  pending 文件落在 $OPENCLAW_STATE_DIR/qqbot-pending.jsonl`);

  if (opts.dryRun) {
    console.log("\n--dry-run：什么都没写。");
    process.exit(0);
  }

  if (!existsSync(backupPath)) copyFileSync(distPath, backupPath);
  writeFileSync(distPath, next);

  const v = syntaxOk(distPath);
  if (!v.ok) {
    copyFileSync(backupPath, distPath);
    die(2, `打完语法校验没过，已回滚：\n${v.message}`);
  }
  console.log("✓ dist/index.cjs 已打补丁，node --check 通过");
  syncSrc(srcPath);

  console.log(
    [
      "",
      "完成。下次启动引擎后生效。",
      `被拦下的人会收到：「${REPLY_TEXT}」`,
      "他的 openid 会追加到 $OPENCLAW_STATE_DIR/qqbot-pending.jsonl，不再只有 24 小时寿命。",
      "",
      "撤销：node scripts/patch-qqbot-reject.mjs --revert",
      "插件升级后重打：再跑一次本脚本。",
    ].join("\n"),
  );
}

main();

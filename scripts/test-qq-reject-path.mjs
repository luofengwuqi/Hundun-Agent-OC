#!/usr/bin/env node
/**
 * test-qq-reject-path.mjs
 *
 * 目的：验证「QQ 私聊被 allowlist 拒绝」这条分支的真实行为，缺凭据也能跑。
 *
 * 做法：**不另抄一份代码**。直接从已安装插件的 `dist/index.cjs` 里抽出现场那段补丁，
 * 塞进一个带桩 ctx 的沙箱里执行。测的是线上真正跑的那几行，不是副本。
 *
 * 覆盖：
 *   A 陌生人私聊 → 落盘（0600、一行）+ 收到中文 + ctx.stop 照旧
 *   B 同一 openid 再来 → 不重复落盘，但仍然回话
 *   C 发送失败 → 兜住，不影响落盘与 stop
 *   D 群消息 → 不落盘、不回话、照旧 stop
 *   E 目录不可写 → 兜住，仍然 stop
 *
 * 用法：
 *   node scripts/test-qq-reject-path.mjs
 *   退出码 0 = 全通过；1 = 有用例失败；2 = 拿不到补丁（插件没装 / 没打补丁）
 */

import { readFileSync, existsSync, mkdirSync, rmSync, statSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOME = homedir();
const PLUGIN_DIST = join(HOME, "文档/馄饨Agent-OC/state/extensions/openclaw-qqbot/dist/index.cjs");

const MARKER = "/*__hundun:qq-reject-patch__*/";
const ANCHOR = 'ctx.stop("access:not_allowlisted");';

/* ---------- 1. 从真实文件里抽出补丁代码 ---------- */
function extractPatch() {
  if (!existsSync(PLUGIN_DIST)) {
    console.error(`✗ 插件没装：${PLUGIN_DIST}`);
    process.exit(2);
  }
  const src = readFileSync(PLUGIN_DIST, "utf8");
  const at = src.indexOf(MARKER);
  if (at < 0) {
    console.error("✗ 插件里没有补丁标记——先跑 scripts/patch-qqbot-reject.mjs");
    process.exit(2);
  }
  const end = src.indexOf(ANCHOR, at);
  if (end < 0) {
    console.error("✗ 找到补丁标记但找不到 ctx.stop 锚点，文件可能被改坏了");
    process.exit(2);
  }
  // ⚠️ 必须**连锚点行一起**抽出来（不要抽到 end 就停）。
  // 补丁是插在 ctx.stop 之前的，如果只抽到 end，ctx.stop 那一行不在沙箱里跑，
  // 就没法验证「补丁没吞掉后续控制流」——第一版测试就是这么假失败的。
  const body = src.slice(at + MARKER.length, end) + "\n" + ANCHOR;
  if (!body.includes("qqbot-pending.jsonl")) {
    console.error("✗ 抽出的片段里没有 qqbot-pending.jsonl，抽取边界错了");
    process.exit(2);
  }
  if (!body.trimEnd().endsWith(ANCHOR)) {
    console.error("✗ 抽出的片段没带上 ctx.stop 锚点行");
    process.exit(2);
  }
  return body;
}

/* ---------- 2. 在子进程里跑，桩 ctx ---------- */
const PROBE = `
const body = process.env.__PATCH_BODY;
const stateDir = process.env.__STATE_DIR;
const openid = process.env.__OPENID;
const isGroup = process.env.__IS_GROUP === "1";
const sendFails = process.env.__SEND_FAILS === "1";

process.env.OPENCLAW_STATE_DIR = stateDir;

const calls = [];
const ctx = {
  stop: (r) => calls.push(["stop", r]),
  replyTarget: { kind: "direct", id: openid },
  bot: {
    sendText: async (target, text) => {
      if (sendFails) throw new Error("stub: network dead");
      calls.push(["sendText", target && target.id, text]);
    },
  },
  log: { warn: (m) => calls.push(["warn", m]) },
};
const id = openid;

// 只执行被抽出来的那一段，外面包一层 async 容器（原文里有 await）
const run = new Function("ctx", "id", "isGroup", "require", "process", \`
  return (async () => {\${body}})();
\`);

run(ctx, id, isGroup, require, process).then(() => {
  process.stdout.write(JSON.stringify({ calls }));
}).catch((e) => {
  process.stdout.write(JSON.stringify({ calls, crash: String(e && e.stack || e) }));
});
`;

/* ---------- 3. 用例 ---------- */
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  — " + detail : ""}`);
}

const body = extractPatch();
console.log(`补丁片段 ${body.split("\n").length} 行（来源：${PLUGIN_DIST.replace(HOME, "~")}）\n`);

function runProbe({ stateDir, openid, isGroup = false, sendFails = false }) {
  const r = spawnSync(process.execPath, ["-e", PROBE], {
    encoding: "utf8",
    env: {
      ...process.env,
      __PATCH_BODY: body,
      __STATE_DIR: stateDir,
      __OPENID: openid,
      __IS_GROUP: isGroup ? "1" : "0",
      __SEND_FAILS: sendFails ? "1" : "0",
    },
  });
  if (r.status !== 0) throw new Error(`probe 退出码 ${r.status}: ${r.stderr?.slice(0, 400)}`);
  return JSON.parse(r.stdout);
}

const SANDBOX = join(tmpdir(), `qq-reject-test-${process.pid}`);
const OID = "TESTOPENID0000000000000000000001";

try {
  /* A：陌生人私聊 */
  rmSync(SANDBOX, { recursive: true, force: true });
  mkdirSync(SANDBOX, { recursive: true, mode: 0o700 });
  const a = runProbe({ stateDir: SANDBOX, openid: OID });
  const fileA = join(SANDBOX, "qqbot-pending.jsonl");
  const hasFile = existsSync(fileA);
  const lines = hasFile ? readFileSync(fileA, "utf8").trim().split("\n") : [];
  const parsed = lines.length === 1 ? JSON.parse(lines[0]) : null;
  const mode = hasFile ? (statSync(fileA).mode & 0o777).toString(8) : "-";

  check("A1 openid 落到 qqbot-pending.jsonl", hasFile && lines.length === 1 && parsed?.openid === OID);
  check("A2 文件权限 0600", mode === "600", `实际 ${mode}`);
  check("A3 带 ISO 时间戳", typeof parsed?.at === "string" && !Number.isNaN(Date.parse(parsed.at)), parsed?.at);
  const sent = a.calls.find((c) => c[0] === "sendText");
  check("A4 回了中文一句", Boolean(sent) && /暂时还不能和你说话/.test(sent[2] || ""));
  check("A5 回给同一个人", sent && sent[1] === OID);
  check("A6 ctx.stop 照旧", a.calls.some((c) => c[0] === "stop" && c[1] === "access:not_allowlisted"));
  check("A7 没有崩溃", !a.crash);

  /* B：同一 openid 再来一次 */
  const b = runProbe({ stateDir: SANDBOX, openid: OID });
  const linesB = readFileSync(fileA, "utf8").trim().split("\n");
  check("B1 不重复落盘", linesB.length === 1, `行数 ${linesB.length}`);
  check("B2 仍然回话", b.calls.some((c) => c[0] === "sendText"));

  /* B'：换个 openid 要能追加 */
  const OID2 = "TESTOPENID0000000000000000000002";
  runProbe({ stateDir: SANDBOX, openid: OID2 });
  const linesB2 = readFileSync(fileA, "utf8").trim().split("\n");
  check("B3 不同 openid 会追加", linesB2.length === 2, `行数 ${linesB2.length}`);

  /* C：发送失败 */
  const SANDBOX_C = join(tmpdir(), `qq-reject-test-c-${process.pid}`);
  rmSync(SANDBOX_C, { recursive: true, force: true });
  mkdirSync(SANDBOX_C, { recursive: true, mode: 0o700 });
  const c = runProbe({ stateDir: SANDBOX_C, openid: OID, sendFails: true });
  check("C1 发送失败被兜住（有 warn）", c.calls.some((x) => x[0] === "warn" && /回话发送失败/.test(x[1])));
  check("C2 发送失败仍落盘", existsSync(join(SANDBOX_C, "qqbot-pending.jsonl")));
  check("C3 发送失败仍 stop", c.calls.some((x) => x[0] === "stop"));
  check("C4 没有崩溃", !c.crash);

  /* D：群消息 */
  const SANDBOX_D = join(tmpdir(), `qq-reject-test-d-${process.pid}`);
  rmSync(SANDBOX_D, { recursive: true, force: true });
  mkdirSync(SANDBOX_D, { recursive: true, mode: 0o700 });
  const d = runProbe({ stateDir: SANDBOX_D, openid: "GROUP00000000000000000000000001", isGroup: true });
  check("D1 群里不落盘", !existsSync(join(SANDBOX_D, "qqbot-pending.jsonl")));
  check("D2 群里不回话", !d.calls.some((x) => x[0] === "sendText"));
  check("D3 群里照旧 stop", d.calls.some((x) => x[0] === "stop"));

  /* E：目录不存在（不可写） */
  const bad = join(tmpdir(), `qq-reject-nope-${process.pid}`, "no-such-dir");
  const e = runProbe({ stateDir: bad, openid: OID });
  check("E1 落盘失败被兜住（有 warn）", e.calls.some((x) => x[0] === "warn" && /落盘失败/.test(x[1])));
  check("E2 落盘失败仍回话", e.calls.some((x) => x[0] === "sendText"));
  check("E3 落盘失败仍 stop", e.calls.some((x) => x[0] === "stop"));
  check("E4 没有崩溃", !e.crash);
} finally {
  for (const d of readdirSync(tmpdir()).filter((n) => n.startsWith("qq-reject-test-") || n.startsWith("qq-reject-nope-"))) {
    if (d.includes(String(process.pid))) rmSync(join(tmpdir(), d), { recursive: true, force: true });
  }
}

/* ---------- 4. 汇总 ---------- */
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) {
  console.log("失败项：");
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? "  " + f.detail : ""}`);
  process.exit(1);
}
console.log("全部通过。注意：这只证明拒绝分支的代码行为，不证明真实 QQ 消息能走到这里（缺凭据）。");

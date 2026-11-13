#!/usr/bin/env node
/**
 * probe-electron-runtime.mjs — 判断「能不能在 Electron 进程里内嵌跑 OpenClaw」
 *
 * 为什么需要这个探测：
 *   OpenClaw 的 src/ 里有上千个文件引用 Node 内置模块 `node:sqlite`，
 *   且 engines 要求 Node >=24.16.0 <25 || >=26.1.0。
 *   Electron 自带的 Node 未必满足任一条，而这一点不能靠猜、也不能靠查文档，
 *   只能在目标二进制上实测。详见 docs/SHAPE-ELECTRON.md §2（R4 为何被排除）与 §7。
 *
 * 用法（不需要图形界面，headless 可跑）：
 *   # 1) 测某个 Electron 二进制自带的 Node
 *   ELECTRON_RUN_AS_NODE=1 /path/to/electron/dist/electron scripts/probe-electron-runtime.mjs
 *
 *   # 2) 对照：直接测本机 node（确认脚本本身没写错）
 *   node scripts/probe-electron-runtime.mjs
 *
 * 退出码：0 = 可内嵌（满足 engines 且有 node:sqlite）；1 = 不可内嵌。
 *
 * 说明：ELECTRON_RUN_AS_NODE 模式下不加载 Chromium，但 Node 内置模块集合
 * 与真实主进程一致，因此对 `node:sqlite` 是否可用的判断是有效的。
 * 若要做真正的端到端验证（含 app ready 之后），另需带显示环境跑主进程。
 */

const ENGINE_MIN_MAJOR = 24;
const ENGINE_MIN_MINOR = 16;
const ENGINE_ALT_MAJOR = 26;
const ENGINE_ALT_MIN_MINOR = 1;

/** 解析 "24.16.0" / "24.16.0-rc.1" 这类版本串为 [major, minor, patch]。 */
function parseVersion(raw) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(raw ?? "").trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** OpenClaw 的 engines 规则：>=24.16.0 <25 或 >=26.1.0（25 不在此列）。 */
function satisfiesEngines(version) {
  const v = parseVersion(version);
  if (!v) return { ok: false, reason: "无法解析 Node 版本" };
  const [major, minor] = v;
  if (major === ENGINE_MIN_MAJOR) {
    return minor >= ENGINE_MIN_MINOR
      ? { ok: true, reason: `命中 ${ENGINE_MIN_MAJOR}.x 线的 >=${ENGINE_MIN_MAJOR}.${ENGINE_MIN_MINOR}` }
      : { ok: false, reason: `${ENGINE_MIN_MAJOR}.x 线需要 >=${ENGINE_MIN_MINOR}，当前 ${minor}` };
  }
  if (major === 25) return { ok: false, reason: "25.x 不被支持（上游明确排除）" };
  if (major >= ENGINE_ALT_MAJOR) {
    if (major === ENGINE_ALT_MAJOR) {
      return minor >= ENGINE_ALT_MIN_MINOR
        ? { ok: true, reason: `命中 ${ENGINE_ALT_MAJOR}.x 线的 >=${ENGINE_ALT_MAJOR}.${ENGINE_ALT_MIN_MINOR}` }
        : { ok: false, reason: `${ENGINE_ALT_MAJOR}.x 线需要 >=${ENGINE_ALT_MIN_MINOR}，当前 ${minor}` };
    }
    return { ok: true, reason: `高于 ${ENGINE_ALT_MAJOR}.x（上游接受 27+）` };
  }
  return { ok: false, reason: `${major}.x 低于支持范围，需 ${ENGINE_MIN_MAJOR}.16+ 或 ${ENGINE_ALT_MAJOR}.1+` };
}

/** 尝试加载 node:sqlite，并做一次真实读写 + WAL 检查。 */
async function probeSqlite() {
  let sqlite;
  try {
    sqlite = await import("node:sqlite");
  } catch (error) {
    return {
      available: false,
      stage: "import",
      code: error?.code ?? "UNKNOWN",
      message: String(error?.message ?? error).split("\n")[0],
    };
  }

  const api = sqlite.DatabaseSync ? "DatabaseSync" : Object.keys(sqlite).join(",") || "(空导出)";
  if (typeof sqlite.DatabaseSync !== "function") {
    return { available: false, stage: "api", code: "NO_DATABASE_SYNC", message: `导出为 ${api}，没有 DatabaseSync` };
  }

  // OpenClaw 依赖的不只是「模块存在」，还要能真的建库、写 WAL。
  // WAL 必须用文件库测：:memory: 上 PRAGMA journal_mode 恒为 memory，会给出假结果。
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  let tmpDir = null;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-probe-"));
    const dbFile = path.join(tmpDir, "probe.sqlite");
    const db = new sqlite.DatabaseSync(dbFile);
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    db.prepare("INSERT INTO t (v) VALUES (?)").run("probe");
    const row = db.prepare("SELECT v FROM t WHERE id = 1").get();
    let journalMode = null;
    try {
      db.exec("PRAGMA journal_mode = WAL");
      journalMode = db.prepare("PRAGMA journal_mode").get()?.journal_mode ?? null;
    } catch (error) {
      journalMode = `WAL 失败: ${String(error?.message ?? error).split("\n")[0]}`;
    }
    db.close();
    const walOk = journalMode === "wal";
    return { available: true, stage: "ok", api, readBack: row?.v ?? null, journalMode, walOk };
  } catch (error) {
    return {
      available: false,
      stage: "runtime",
      code: error?.code ?? "UNKNOWN",
      message: String(error?.message ?? error).split("\n")[0],
    };
  } finally {
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* 清理失败不影响结论 */
      }
    }
  }
}

function line(label, value) {
  const text = value === undefined || value === null ? "—" : String(value);
  console.log(`  ${label.padEnd(22)} ${text}`);
}

async function main() {
  const v = process.versions;
  const isElectron = Boolean(v.electron);

  console.log("\n=== 运行时标识 ===");
  line("模式", isElectron ? "Electron 自带 Node（ELECTRON_RUN_AS_NODE）" : "普通 Node");
  line("process.execPath", process.execPath);
  line("node", v.node);
  line("electron", v.electron);
  line("chrome", v.chrome);
  line("v8", v.v8);
  line("modules (ABI)", v.modules);

  const engines = satisfiesEngines(v.node);
  console.log("\n=== engines 检查（OpenClaw：>=24.16.0 <25 || >=26.1.0）===");
  line("结论", engines.ok ? "满足" : "不满足");
  line("依据", engines.reason);

  console.log("\n=== node:sqlite 检查（OpenClaw 有上千文件依赖它）===");
  const sqlite = await probeSqlite();
  if (sqlite.available) {
    line("可用", "是");
    line("API", sqlite.api);
    line("读写回环", sqlite.readBack === "probe" ? "通过" : `异常（${sqlite.readBack}）`);
    line("文件库 WAL", sqlite.journalMode);
  } else {
    line("可用", "否");
    line("失败阶段", sqlite.stage);
    line("错误码", sqlite.code);
    line("错误信息", sqlite.message);
  }

  const pass = engines.ok && sqlite.available;
  console.log("\n=== 判定 ===");
  if (pass) {
    console.log("  可内嵌：可把 OpenClaw 作为库跑在该运行时里（R4 路线可行）。");
    if (sqlite.walOk === false) {
      console.log("  ⚠ 但文件库无法启用 WAL。上游要求 WAL-reset-safe 的 SQLite（docs/install/node.md），");
      console.log("    这一项不通过同样不能承载，需单独排查链接的 SQLite 版本。");
    }
    console.log("  仍需另做一次带 app ready 的主进程端到端验证，才算证据充分。");
  } else {
    console.log("  不可内嵌：该运行时不能直接承载 OpenClaw。");
    if (!engines.ok) console.log(`    · Node 版本不满足 engines（${v.node}）`);
    if (!sqlite.available) console.log("    · node:sqlite 不可用，且没有 polyfill 空间");
    console.log("  结论：壳必须外挂子进程，并自带一个满足 engines 的 Node 运行时。");
    console.log("  参考 docs/SHAPE-ELECTRON.md §2（R3 主路）与 §6 坑 2。");
  }
  console.log();

  process.exit(pass ? 0 : 1);
}

main().catch((error) => {
  console.error("探测脚本自身出错：", error);
  process.exit(2);
});

#!/usr/bin/env node
/**
 * 真跑一次：起引擎 → 等 /readyz → SIGTERM 收尾 → 确认进程真的没了。
 *
 * 为什么要有这个脚本：进程管理是这套壳里最容易「看起来对、实际不对」的部分。
 * 单测能证明函数返回值，证明不了「SIGTERM 之后引擎会不会留在后台」——那必须真起一次。
 *
 * 它**不碰**用户的 ~/.openclaw：临时 userData 目录，用完就删。
 *
 * 用法：node scripts/dev-engine-smoke.mjs
 * 前置：npm run build（本脚本跑的是编译后的 dist）
 */
import { createRequire } from "node:module";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const { resolveEnginePaths } = require(join(repoRoot, "dist/main/engine/paths.js"));
const { ensureConfigFile, readGatewayToken } = require(join(repoRoot, "dist/main/engine/config.js"));
const { findFreePort } = require(join(repoRoot, "dist/main/engine/port.js"));
const { startEngine, probeReady, clearRuntimeRecord } = require(
  join(repoRoot, "dist/main/engine/supervise.js"),
);

function fail(step, error) {
  console.error(`\n✗ 失败于：${step}`);
  console.error(error?.message ?? error);
  if (error?.logs) console.error("\n--- 引擎最后输出 ---\n" + error.logs.slice(-30).join("\n"));
  process.exitCode = 1;
}

async function main() {
  // 记忆现在落在「文档目录」下（D024）。冒烟测试必须造一个假文档目录，
  // 否则跑一次测试就往用户真实的 ~/Documents 里写一份假记忆。
  const root = await mkdtemp(join(tmpdir(), "hundun-smoke-"));
  const userData = join(root, "userData");
  const documents = join(root, "documents");
  console.log(`临时根目录：${root}`);
  console.log(`  应用数据：${userData}`);
  console.log(`  文档目录：${documents}（假装是用户的文档目录）`);

  let handle;
  try {
    const paths = resolveEnginePaths({
      userData,
      documents,
      appRoot: repoRoot,
      isPackaged: false,
    });
    console.log(`记忆目录：${paths.engineHome}`);
    console.log(`引擎入口：${paths.engineEntry}`);
    console.log(`Node    ：${paths.nodeBinary}`);

    const seed = await ensureConfigFile(paths.configFile);
    console.log(`配置    ：${seed.created ? "新建" : "已存在"} ${paths.configFile}`);
    for (const warning of seed.warnings) console.log(`  ⚠ ${warning}`);

    const token = await readGatewayToken(paths.configFile);
    if (!token) throw new Error("配置里读不到 gateway.auth.token");

    const port = await findFreePort();
    console.log(`端口    ：${port}（刻意避开 18789）`);

    const startedAt = Date.now();
    handle = await startEngine({
      paths,
      port,
      token,
      onLog: (line) => {
        // 只打关键行，否则引擎日志会淹掉结论
        if (/ready|listen|error|Error|ERROR|panic/.test(line)) console.log(`  · ${line}`);
      },
    });
    console.log(`\n✓ 引擎就绪，用时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s，pid=${handle.pid}`);

    const readyAgain = await probeReady(port);
    if (!readyAgain) throw new Error("/readyz 复查未通过");
    console.log("✓ /readyz 复查通过");

    if (!handle.pid || !existsSync(`/proc/${handle.pid}`)) {
      throw new Error("拿不到 pid 或进程不存在");
    }
    console.log(`✓ 进程存在：/proc/${handle.pid}`);

    const stoppedAt = Date.now();
    await handle.stop();
    const stopMs = Date.now() - stoppedAt;
    console.log(`\n✓ 收尾完成，用时 ${stopMs}ms`);

    if (stopMs > 11_000) throw new Error(`收尾超过 11s（${stopMs}ms），预算失效`);

    // 关键断言：不能留下孤儿进程。这是 SHELL-SKELETON §4 里最容易被忽略的一条。
    const stillThere = existsSync(`/proc/${handle.pid}`);
    if (stillThere) throw new Error(`进程 ${handle.pid} 收尾后仍存在——孤儿！`);
    console.log("✓ 无孤儿进程");

    console.log(`\n全部通过。日志行数：${handle.logs().length}`);
  } catch (error) {
    fail("smoke", error);
  } finally {
    try {
      if (handle) await handle.stop();
    } catch {
      /* 已在失败路径里收过 */
    }
    const paths = resolveEnginePaths({ userData, documents, appRoot: repoRoot, isPackaged: false });
    await clearRuntimeRecord(paths.runtimeRecord).catch(() => undefined);
    if (!process.env.KEEP_SMOKE_DIR) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    } else {
      console.log(`保留目录：${root}`);
    }
  }
}

// 漏网的 openclaw 子进程会一直占着临时目录，失败时给出提示而不是静默退出。
process.on("exit", (code) => {
  if (code !== 0) {
    console.error("\n提示：若怀疑有残留引擎进程，用 `ss -ltnp | grep 188` 查看端口，按 pid 处理。");
  }
});

await main();

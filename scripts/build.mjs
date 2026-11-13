#!/usr/bin/env node
/**
 * 构建：tsc 编译主进程与 preload，再把渲染层资源复制进 dist。
 *
 * 为什么不用 shell 的 cp -r：Windows 上没有 cp。构建脚本被平台差异绊倒是很蠢的延误。
 */
import { cp, mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const tsc = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["tsc", "-p", "tsconfig.json"],
  { cwd: repoRoot, stdio: "inherit" },
);
if (tsc.status !== 0) process.exit(tsc.status ?? 1);

await rm(join(repoRoot, "dist", "renderer"), { recursive: true, force: true });
await mkdir(join(repoRoot, "dist", "renderer"), { recursive: true });
await cp(join(repoRoot, "src", "renderer"), join(repoRoot, "dist", "renderer"), {
  recursive: true,
});

console.log("build ok → dist/");

#!/usr/bin/env node
/**
 * 开发期启动器。它解决的问题都不是本工程的 bug，而是「从别的 Electron 应用里启动 Electron」会踩的环境坑：
 *
 * 1. ELECTRON_RUN_AS_NODE=1
 *    很多 Electron 系 IDE（VS Code / Cursor / 各类 AI 编辑器）会给子进程设这个变量。
 *    Electron 二进制看到它就直接退化成纯 Node 跑 —— 于是 require("electron") 只返回一个路径字符串，
 *    主进程在 app.whenReady() 处报 "Cannot read properties of undefined (reading 'whenReady')"。
 *    这个变量必须先摘掉，否则问题看起来像代码写错了。
 *
 * 2. Linux 的 SUID sandbox
 *    Chromium 要求 chrome-sandbox 属于 root 且权限 4755。npm 装出来的文件不具备，
 *    于是 Electron 直接 FATAL 退出。改权限要 sudo，不该由构建脚本偷偷做，
 *    所以这里只在确认不具备时降级到 --no-sandbox，并把原因说清楚。
 *
 * 真打包分发给用户时走的是 electron-builder 产出的安装包，两者都不适用。
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const electronBinary = require("electron");
const args = [repoRoot, ...process.argv.slice(2)];

const env = { ...process.env };
const notes = [];

// 坑 1：Electron 退化成 Node
if (env.ELECTRON_RUN_AS_NODE) {
  delete env.ELECTRON_RUN_AS_NODE;
  notes.push("已摘掉 ELECTRON_RUN_AS_NODE（宿主 IDE 注入，会让 Electron 退化成纯 Node）");
}
// NODE_OPTIONS 里的 --require 钩子同理：那是给宿主自身 Node 进程用的，灌进 Electron 会报错
if (env.NODE_OPTIONS && /node-language-shim|workbuddy|vscode/i.test(env.NODE_OPTIONS)) {
  notes.push(`已忽略来自宿主的 NODE_OPTIONS（${env.NODE_OPTIONS}）`);
  delete env.NODE_OPTIONS;
}

// 坑 2：Linux SUID sandbox
if (process.platform === "linux") {
  const sandbox = path.join(path.dirname(electronBinary), "chrome-sandbox");
  let usable = false;
  try {
    const st = fs.statSync(sandbox);
    usable = st.uid === 0 && (st.mode & 0o4000) !== 0;
  } catch {
    usable = false;
  }
  if (!usable) {
    args.push("--no-sandbox");
    notes.push(
      "chrome-sandbox 没有 root 属主 + 4755 权限，本次以 --no-sandbox 启动（仅开发期）。" +
        "想恢复沙箱请执行：sudo chown root:root " +
        sandbox +
        " && sudo chmod 4755 " +
        sandbox,
    );
  }
}

for (const note of notes) console.log(`[launch] ${note}`);

const child = spawn(electronBinary, args, { stdio: "inherit", env });
child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`[launch] Electron 被信号 ${signal} 终止`);
    process.exit(1);
  }
  process.exit(code ?? 0);
});

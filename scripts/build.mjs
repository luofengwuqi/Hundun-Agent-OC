#!/usr/bin/env node
/**
 * 构建：主进程 / preload 走 tsc，渲染层走 esbuild + @vue/compiler-sfc。
 *
 * 为什么主进程不交给 esbuild：那边已经有 tsc 的严格类型检查在把关，
 * 换打包器会顺手丢掉那层保护。两段各用各的强项。
 *
 * 为什么渲染层不用 Vite：参考项目在本机踩过——Node 虚拟内存受限时 Vite 加载会触发
 * undici 的 WASM 初始化并直接 OOM。esbuild 是原生二进制、@vue/compiler-sfc 是纯 JS，
 * 两者都不碰 WASM。这不是保守，是这个环境下唯一能稳定跑通的路。
 *
 * 产出：
 *   dist/main/*.js          CJS（tsc）
 *   dist/preload/index.js   CJS（tsc）
 *   dist/renderer/index.html
 *   dist/renderer/assets/app.js + app.css
 *   dist/renderer/logo.svg、icon.png（public 原样拷）
 */
import { cp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { parse, compileScript } from "@vue/compiler-sfc";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(repoRoot, "dist");

/** 把 .vue 编成纯 JS（script setup + 内联模板）。取自参考项目已验证的实现。 */
const vuePlugin = {
  name: "vue-sfc",
  setup(build) {
    build.onLoad({ filter: /\.vue$/ }, async (args) => {
      const source = await readFile(args.path, "utf8");
      const id = createHash("md5").update(args.path).digest("hex").slice(0, 8);
      const { descriptor, errors } = parse(source, { filename: args.path });
      if (errors && errors.length) {
        return { errors: errors.map((e) => ({ text: String(e.message || e) })) };
      }
      if (!descriptor.script && !descriptor.scriptSetup) {
        return { errors: [{ text: `${args.path} 没有 <script> 块` }] };
      }
      const compiled = compileScript(descriptor, { id, inlineTemplate: true });
      return {
        contents: compiled.content,
        loader: "js",
        resolveDir: dirname(args.path),
      };
    });
  },
};

function runTsc() {
  const tsc = spawnSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["tsc", "-p", "tsconfig.json"],
    { cwd: repoRoot, stdio: "inherit" },
  );
  if (tsc.status !== 0) process.exit(tsc.status ?? 1);
}

async function buildRenderer() {
  await rm(join(dist, "renderer"), { recursive: true, force: true });
  await mkdir(join(dist, "renderer", "assets"), { recursive: true });

  await esbuild.build({
    entryPoints: [join(repoRoot, "src", "renderer", "src", "main.js")],
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "chrome120",
    outfile: join(dist, "renderer", "assets", "app.js"),
    plugins: [vuePlugin],
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "warning",
  });

  // public/ 原样拷（logo、图标）。模板里的相对路径不打进 bundle，靠这里落位。
  const pub = join(repoRoot, "src", "renderer", "public");
  await cp(pub, join(dist, "renderer"), { recursive: true });

  const html = await readFile(join(repoRoot, "src", "renderer", "index.html"), "utf8");
  const bundle = [
    '<link rel="stylesheet" href="./assets/app.css" />',
    '<script src="./assets/app.js"></script>',
  ].join("\n    ");
  await writeFile(join(dist, "renderer", "index.html"), html.replace("<!--BUNDLE-->", bundle));
}

runTsc();
await buildRenderer();

console.log("build ok → dist/");

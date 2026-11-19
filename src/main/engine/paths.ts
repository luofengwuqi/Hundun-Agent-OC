/**
 * 路径的唯一事实源（SHELL-SKELETON §1 纪律 3）。
 *
 * 别的模块不许自己拼 userData / appRoot 的路径——换存储位置时只会漏改一处，
 * 而且漏掉的那一处通常只在打包后才暴露。
 *
 * 本文件**不 import electron**：main 进程把 app.getPath("userData") 与 app.getAppPath()
 * 传进来，测试与 smoke 脚本可以直接给普通字符串。这样引擎层可以脱离 Electron 跑。
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface EnginePaths {
  /**
   * 记忆与人格的根目录。等价于喂给子进程的 OPENCLAW_HOME。
   * **放在用户文档目录下，不放应用数据目录**（D024）——理由是卸载器会删后者，
   * 而这里装着一个人全部的日记。
   */
  readonly engineHome: string;
  /** 人格与记忆所在的工作区，用户要能打开这个文件夹。 */
  readonly workspace: string;
  /** 引擎配置文件（由我们生成，不手改）。内含凭据，权限 0600。 */
  readonly configFile: string;
  /** SQLite 状态目录。 */
  readonly stateDir: string;
  /** 应用自己的数据（运行时记录等）。卸载时可以随便删，不影响记忆。 */
  readonly dataDir: string;
  /** 壳自己写的运行时记录（pid / port），用于接管孤儿进程。放 dataDir，不放记忆目录。 */
  readonly runtimeRecord: string;
  /** 要跑的可执行文件。dev 下是系统 node 名，打包后是安装包内的绝对路径。 */
  readonly nodeBinary: string;
  /** 引擎入口 dist/index.js 的绝对路径。 */
  readonly engineEntry: string;
  /** 引擎包根目录（用于读版本、找 docs 等）。 */
  readonly engineRoot: string;
  readonly isPackaged: boolean;
}

export interface ResolveEnginePathsInput {
  /** 应用数据目录（Electron 的 app.getPath("userData")）。 */
  readonly userData: string;
  /**
   * 用户文档目录（Electron 的 app.getPath("documents")）。
   * 传进来而不是自己拼 `~/Documents`：Windows 上「文档」可能被重定向到 OneDrive，
   * Linux 上则取决于 XDG 配置，手拼必错。
   */
  readonly documents: string;
  readonly appRoot: string;
  readonly isPackaged: boolean;
  readonly env?: NodeJS.ProcessEnv;
}

/** 文档目录下的子目录名。用户的记忆就住在这里，卸载不会碰。 */
export const MEMORY_DIR_NAME = "馄饨Agent-OC";

/** 开发期默认的引擎位置：本机 npm 全局装的 openclaw。可用 OPENCLAW_DEV_ENGINE 覆盖。 */
const DEV_ENGINE_DEFAULT = join(homedir(), ".local", "lib", "node_modules", "openclaw");

function engineEntryOf(root: string): string {
  return join(root, "dist", "index.js");
}

function resolveDevEngineRoot(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.OPENCLAW_DEV_ENGINE?.trim();
  const root = fromEnv && fromEnv.length > 0 ? fromEnv : DEV_ENGINE_DEFAULT;
  if (!existsSync(engineEntryOf(root))) {
    throw new Error(
      [
        `开发模式找不到引擎入口：${engineEntryOf(root)}`,
        "两种办法：",
        "  1) 装一份 openclaw（npm i -g openclaw），或",
        "  2) 设置 OPENCLAW_DEV_ENGINE 指向 openclaw 包根目录（含 dist/index.js 的那层）。",
      ].join("\n"),
    );
  }
  return root;
}

export function resolveEnginePaths(input: ResolveEnginePathsInput): EnginePaths {
  const env = input.env ?? process.env;
  // 记忆放文档目录，**不**放 userData：后者卸载时会被删（D024）
  const engineHome = join(input.documents, MEMORY_DIR_NAME);
  const dataDir = input.userData;

  const engineRoot = input.isPackaged
    ? join(input.appRoot, "engine", "openclaw")
    : resolveDevEngineRoot(env);

  // 打包后必须用安装包自带的 Node（D023）：Electron 自带的 Node 跑不了 node:sqlite。
  // 开发期用环境里的 node，避免为了跑一次 smoke 先复制 122 MB。
  const nodeBinary = input.isPackaged
    ? join(input.appRoot, "engine", "node", "bin", "node")
    : (env.OPENCLAW_DEV_NODE?.trim() || "node");

  return {
    engineHome,
    // ⚠️ 必须和引擎解析出的 workspace 是同一个目录（D031 重置失效的根因）。
    // 引擎 workspace-default-path.ts：设了 OPENCLAW_STATE_DIR 时，
    // workspace = join(resolveStateDir(env), "workspace") = engineHome/state/workspace。
    // 之前这里少了一层 state，指向 engineHome/workspace（空目录），导致：
    //   - 重置记忆删的是空目录，真正的记忆在 state/workspace 纹丝不动；
    //   - 开发者重置后模型仍记得旧对话。
    // buildEnv 里另设 OPENCLAW_WORKSPACE_DIR 显式钉死，避免引擎改默认规则时再漂移。
    stateDir: join(engineHome, "state"),
    workspace: join(engineHome, "state", "workspace"),
    configFile: join(engineHome, "openclaw.json"),
    dataDir,
    runtimeRecord: join(dataDir, "shell-runtime.json"),
    nodeBinary,
    engineEntry: engineEntryOf(engineRoot),
    engineRoot,
    isPackaged: input.isPackaged,
  };
}

/**
 * 打包后必须检查这些路径真实存在，且失败要**说清缺了哪个**。
 * 缺 engine 的安装包会在启动瞬间崩，用户只看到「闪退」。
 */
export function assertPackagedAssets(paths: EnginePaths): void {
  if (!paths.isPackaged) return;
  const missing: string[] = [];
  if (!existsSync(paths.nodeBinary)) missing.push(`Node 运行时：${paths.nodeBinary}`);
  if (!existsSync(paths.engineEntry)) missing.push(`引擎入口：${paths.engineEntry}`);
  if (missing.length > 0) {
    throw new Error(`安装包不完整，缺少：\n  - ${missing.join("\n  - ")}`);
  }
}

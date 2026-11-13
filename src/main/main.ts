/**
 * 壳的主进程：只管生命周期与窗口，不做对话逻辑（D013）。
 *
 * 第一版的边界（刻意收窄）：
 *   ✅ 起引擎、等就绪、收尾、异常分类、接管孤儿、状态界面
 *   ❌ 对话收发——需要先验证 OpenAI 兼容 HTTP 接口的配置键；写错键会让引擎以 78 退出，
 *      所以这一步留到下一版，宁可界面上明说「还没接」。
 */
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { join } from "node:path";
import { ensureConfigFile, readGatewayToken } from "./engine/config";
import { findAdoptableEngine, probeReady, startEngine, clearRuntimeRecord, type EngineHandle, type RuntimeRecord } from "./engine/supervise";
import { findFreePort } from "./engine/port";
import { assertPackagedAssets, resolveEnginePaths, type EnginePaths } from "./engine/paths";
import type { EngineFailure } from "./engine/errors";

interface ShellState {
  status: "booting" | "starting" | "ready" | "failed" | "stopped";
  port: number | null;
  pid: number | null;
  adopted: boolean;
  failure: EngineFailure | null;
  notice: string | null;
}

const emptyState = (): ShellState => ({
  status: "booting",
  port: null,
  pid: null,
  adopted: false,
  failure: null,
  notice: null,
});

let state: ShellState = emptyState();
let engine: EngineHandle | undefined;
let paths: EnginePaths | undefined;
let mainWindow: BrowserWindow | undefined;
/** 收尾期间窗口正在销毁，此时再往渲染进程发消息只会刷一屏 "Render frame was disposed"。 */
let shuttingDown = false;

/**
 * 往渲染层发消息前的统一关卡。
 * 只判断 mainWindow.isDestroyed() 不够：退出时 BrowserWindow 还活着，但它的 webContents
 * 已经 dispose，send 会抛 "Render frame was disposed before WebFrameMain could be accessed"。
 */
function sendToWindow(channel: string, payload: unknown): void {
  if (shuttingDown || !mainWindow || mainWindow.isDestroyed()) return;
  const contents = mainWindow.webContents;
  if (!contents || contents.isDestroyed()) return;
  contents.send(channel, payload);
}

function broadcast(): void {
  sendToWindow("shell:state", publicState());
}

function publicState(): Record<string, unknown> {
  return {
    status: state.status,
    port: state.port,
    pid: state.pid,
    adopted: state.adopted,
    failure: state.failure,
    notice: state.notice,
    // 记忆根（文档目录下），卸载不会删（D024）
    memoryDir: paths?.engineHome ?? null,
    // 应用自己的数据（缓存、运行时记录），卸载可以删
    dataDir: paths?.dataDir ?? null,
  };
}

async function bootEngine(): Promise<void> {
  if (!paths) return;
  state = { ...emptyState(), status: "starting" };
  broadcast();

  // 上一次壳崩了但引擎还活着 → 接管，而不是再起一个（SHELL-SKELETON §4.2）。
  const adoptable = await findAdoptableEngine(paths.runtimeRecord);
  if (adoptable) {
    state = {
      ...emptyState(),
      status: "ready",
      port: adoptable.port,
      pid: adoptable.pid,
      adopted: true,
      notice: "接上了上次没有正常关闭的陪伴引擎。",
    };
    broadcast();
    return;
  }
  // 记录存在但探不通 → 是一次不干净的退出，清掉免得下次误判
  await clearRuntimeRecord(paths.runtimeRecord);

  try {
    const seed = await ensureConfigFile(paths.configFile);
    const token = await readGatewayToken(paths.configFile);
    if (!token) throw new Error("配置里读不到 gateway.auth.token");

    const port = await findFreePort();
    engine = await startEngine({
      paths,
      port,
      token,
      onLog: (line) => {
        sendToWindow("shell:log", line);
      },
    });
    state = {
      ...emptyState(),
      status: "ready",
      port,
      pid: engine.pid ?? null,
      notice: seed.warnings.length > 0 ? seed.warnings.join("\n") : null,
    };
    broadcast();
  } catch (error) {
    const failure = (error as { failure?: EngineFailure }).failure;
    state = {
      ...emptyState(),
      status: "failed",
      failure: failure ?? {
        kind: "unknown",
        retryable: false,
        userMessage: error instanceof Error ? error.message : String(error),
      },
    };
    broadcast();
  }
}

function requirePaths(): EnginePaths {
  if (!paths) throw new Error("paths 尚未初始化");
  return paths;
}

function currentStatus(): Record<string, unknown> {
  return {
    ...publicState(),
    logs: engine ? engine.logs().slice(-120) : [],
  };
}

function registerIpc(): void {
  ipcMain.handle("shell:get-state", () => currentStatus());

  ipcMain.handle("shell:restart-engine", async () => {
    if (engine) {
      await engine.stop();
      engine = undefined;
    }
    await bootEngine();
    return currentStatus();
  });

  ipcMain.handle("shell:open-data-dir", async () => {
    const target = requirePaths().engineHome;
    await shell.openPath(target);
    return target;
  });

  ipcMain.handle("shell:open-workspace", async () => {
    const target = requirePaths().workspace;
    await shell.openPath(target);
    return target;
  });

  ipcMain.handle("shell:probe", async () => {
    if (!state.port) return false;
    return probeReady(state.port);
  });
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 880,
    height: 720,
    minWidth: 560,
    minHeight: 480,
    show: false,
    title: "馄饨Agent-OC",
    backgroundColor: "#12100e",
    webPreferences: {
      preload: join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  await mainWindow.loadFile(join(__dirname, "..", "renderer", "index.html"));
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });
}

app.whenReady().then(async () => {
  try {
    paths = resolveEnginePaths({
      userData: app.getPath("userData"),
      // 记忆落在文档目录（D024）。用 Electron 的路径 API 而不是手拼 ~/Documents：
      // Windows 上「文档」可能被重定向到 OneDrive，Linux 上取决于 XDG 配置。
      documents: app.getPath("documents"),
      appRoot: app.isPackaged ? process.resourcesPath : app.getAppPath(),
      isPackaged: app.isPackaged,
    });
    assertPackagedAssets(paths);
  } catch (error) {
    dialog.showErrorBox(
      "无法启动",
      error instanceof Error ? error.message : String(error),
    );
    app.quit();
    return;
  }

  registerIpc();
  await createWindow();
  void bootEngine();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});

/**
 * 收尾顺序很重要：先停引擎，再退出。
 * 注意这里**没有**用 315s 的上游预算（SHELL-SKELETON §4.1）。
 */
let quitting = false;
app.on("before-quit", (event) => {
  shuttingDown = true;
  if (quitting || !engine) return;
  event.preventDefault();
  quitting = true;
  void engine.stop().finally(() => {
    engine = undefined;
    app.quit();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

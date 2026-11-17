/**
 * 壳的主进程：只管生命周期与窗口，不做对话逻辑（D013）。
 *
 * 当前边界：
 *   ✅ 起引擎、等就绪、收尾、异常分类、接管孤儿、状态界面
 *   ✅ 托盘常驻：关窗只是隐藏，托盘点「退出」才真退（D026）
 *   ❌ 对话收发——需要先验证 OpenAI 兼容 HTTP 接口的配置键；写错键会让引擎以 78 退出，
 *      所以这一步留到下一版，宁可界面上明说「还没接」。
 */
import { app, BrowserWindow, dialog, ipcMain, shell, Tray, Menu, nativeImage, Notification } from "electron";
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
/** 用户明确要求退出（托盘菜单 / 系统关机）。只有它能让 close 事件放行。 */
let forceQuit = false;
/** 托盘创建成功与否。**没托盘就绝不能 hide**——窗口一藏用户再也找不回来。 */
let tray: Tray | undefined;
let hiddenHinted = false;

/**
 * 关窗只是收起来（D026）。
 *
 * 这不是习惯问题：D014 定了「一天随机时间主动关心一次」，关窗即退出的应用
 * 在用户关窗那一刻就把主动关心杀死了。
 */
function hideToTray(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.hide();
  // 用户以为关了、其实还在跑——不说一声就是欺骗
  if (!hiddenHinted) {
    hiddenHinted = true;
    try {
      if (Notification.isSupported()) {
        new Notification({
          title: "馄饨还在",
          body: "窗口收起来了。从托盘图标可以再打开，或点「退出」结束它。",
        }).show();
      }
    } catch {
      // 通知不可用（缺 libnotify 之类）就算了：托盘图标本身才是主路径
    }
  }
}

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    void createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/**
 * 托盘。Linux 上依赖桌面环境的 AppIndicator 支持，缺扩展时 Electron 可能建得出对象
 * 但图标不显示——所以**创建失败要回退**，回退到「关窗即退出」，而不是留一个藏起来找不回的窗口。
 */
function createTray(): void {
  // tray.png 与界面里的 logo 是同一枚标记（红线稿 + 奶油黄填充），只是烘成 32px 位图：
  // 系统托盘收不了 SVG，Electron 的 Tray 只认位图。
  const iconPath = join(__dirname, "..", "renderer", "tray.png");
  try {
    const image = nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) throw new Error(`托盘图标读不出来：${iconPath}`);
    tray = new Tray(image);
    tray.setToolTip("馄饨Agent-OC");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "打开馄饨", click: showWindow },
        { type: "separator" },
        {
          label: "打开记忆目录",
          click: () => {
            if (paths) void shell.openPath(paths.engineHome);
          },
        },
        { type: "separator" },
        {
          label: "退出",
          click: () => {
            forceQuit = true;
            app.quit();
          },
        },
      ]),
    );
    // Windows / Linux 上单击托盘 = 打开窗口；macOS 上习惯是弹菜单，故不绑
    if (process.platform !== "darwin") tray.on("click", showWindow);
  } catch (error) {
    tray = undefined;
    console.error("[tray] 托盘不可用，回退为「关窗即退出」：", error);
  }
}

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

  // 记忆根（文档目录下）。用户要备份的就是这个文件夹，卸载不会删它（D024）
  ipcMain.handle("shell:open-memory-dir", async () => {
    const target = requirePaths().engineHome;
    await shell.openPath(target);
    return target;
  });

  // 应用自己的数据（缓存、运行时记录）。诊断时才看，卸载可删
  ipcMain.handle("shell:open-data-dir", async () => {
    const target = requirePaths().dataDir;
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

  // 无边框窗口的自绘按钮（frame: false，D025）
  ipcMain.on("shell:win-minimize", () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
  });
  /**
   * 这里**故意走 close() 而不是 hide()**：close 事件里统一判断
   * （forceQuit || 没有托盘 → 放行退出；否则 preventDefault + hide）。
   * 直接 hide() 会绕过那个判断，没托盘时窗口就再也找不回来了。
   */
  ipcMain.on("shell:win-close", () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  });

  /**
   * 开发期专用：验证「托盘退出」这条路径。
   *
   * 原生托盘菜单没法用脚本点，但这条路径最容易出错——forceQuit 与 before-quit 的配合
   * 一旦写反，要么点了退出没反应，要么退出时把引擎丢成孤儿。所以留一个可自动化的入口。
   * **只在非打包时注册**：安装给用户的那份里没有这个 IPC，调用无效。
   */
  if (!app.isPackaged) {
    ipcMain.on("shell:dev-quit", () => {
      forceQuit = true;
      app.quit();
    });
  }
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1020,
    height: 700,
    minWidth: 780,
    minHeight: 540,
    show: false,
    // 无边框 + 自绘标题栏，视觉与参考项目一致（D025）。
    // 拖拽区由渲染层的 -webkit-app-region: drag 提供，不需要这里再加。
    frame: false,
    title: "馄饨Agent-OC",
    // 与 styles.css 的 --bg 同色，避免窗口出现前闪一下别的颜色
    backgroundColor: "#fff8e8",
    // 任务栏/窗口图标与界面里是同一枚标记（public/icon.png 构建时拷进 dist/renderer/）。
    // 不设的话 Linux 上会沿用 Electron 默认图标，跟界面里的馄饨对不上。
    icon: join(__dirname, "..", "renderer", "icon.png"),
    webPreferences: {
      preload: join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());

  // 关窗 = 收起来（D026）。没有托盘时必须放行，否则窗口藏起来就找不回来了。
  mainWindow.on("close", (event) => {
    if (forceQuit || !tray) return;
    event.preventDefault();
    hideToTray();
  });

  await mainWindow.loadFile(join(__dirname, "..", "renderer", "index.html"));
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });
}

/**
 * 不要在这里调 `app.disableHardwareAcceleration()`。
 *
 * 2026-11-17 曾经加过又撤了。当时的理由是「Chromium 报
 * `FATAL GPU process isn't usable. Goodbye.`，整个应用被处决」，听上去对托盘常驻很致命。
 * 但做了对照实验才发现：**开着和关掉硬件加速都稳定**，那个 FATAL 是验证方式本身造的——
 * 用 `nohup ... &` 起的实例，在工具链的进程树收割中 zygote 先死，network service 与
 * GPU 进程跟着死，Chromium 于是打出一条看着像显卡崩溃的 FATAL。
 *
 * 也就是说：**症状是真的，归因是错的。** 按错误归因改代码，等于用一个假故障换掉真功能
 * （这里换掉的是硬件加速）。真正该记的教训在 `SHELL-SKELETON.md` §8.6，不在代码里。
 *
 * 唯一真实存在的现象是 Wayland 上的一条非致命警告：
 *   `'--ozone-platform=wayland' is not compatible with Vulkan`
 * 它只是让合成回退，不影响使用。真要处理，应该是排查驱动，而不是在壳里永久关掉 GPU。
 */

/**
 * 单实例锁。托盘常驻之后这条从「锦上添花」变成「必须」：
 * 用户以为关了窗口，再点一次桌面图标——没有锁就会起第二个实例，
 * 两个 Electron 各自 spawn 一个引擎抢同一个状态目录。上游的 file lock 会让第二个起不来，
 * 但用户看到的是两个窗口、其中一个一直转圈。锁在这里，第二个进程直接把窗口叫回来。
 */
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
else app.on("second-instance", () => showWindow());

app.whenReady().then(async () => {
  // 没拿到锁说明已有实例在跑，本进程正在退出，不要再建窗口
  if (!hasSingleInstanceLock) return;
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
  // 托盘要先于窗口建好：否则第一次关窗时 tray 还是 undefined，close 会直接放行退出
  createTray();
  await createWindow();
  void bootEngine();
});

app.on("activate", () => {
  // macOS 点 Dock 图标 / 其他平台再次唤起：把已有窗口叫回来（它可能只是被隐藏了）
  showWindow();
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
  // 有托盘就是后台常驻（D026）。正常路径下窗口是 hide 而非 close，走不到这里；
  // 走到这里说明确实要关（托盘不可用的回退，或用户点了「退出」）。
  if (tray) return;
  if (process.platform !== "darwin") app.quit();
});

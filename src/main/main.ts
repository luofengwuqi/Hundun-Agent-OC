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
import { readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ensureConfigFile,
  readGatewayToken,
  readModelRef,
  readSavedProviders,
  writeModelProviders,
} from "./engine/config";
import { readSecrets, writeSecrets } from "./engine/secrets";
import { ChatError, streamChat, type ChatTurn } from "./engine/chat";
import { correctAssistantTurn, loadChatHistory, saveChatHistory } from "./engine/chathistory";
import { readRemoteTurns, type RemoteTurn } from "./engine/transcript";
import {
  checkAssistantOrigin,
  rememberAssistantTurn,
  replaceAssistantHash,
  validateOutgoingHistory,
} from "./engine/historyguard";
import {
  confirmUserName,
  dismissPendingName,
  getProfileView,
  reconcileProfile,
} from "./engine/profile";
import { normalize, moveModel, addModel, removeModel, setProviderModels } from "./engine/modelconfig";
import { ensureOpencode } from "./engine/claudeconfig";
import { probeModels } from "./engine/modelprobe";
import { applyModelConfig } from "./engine/modelapply";
import { findAdoptableEngine, probeReady, startEngine, clearRuntimeRecord, type EngineHandle, type RuntimeRecord } from "./engine/supervise";
import { findFreePort } from "./engine/port";
import { resetMemory, RESET_NOTICE } from "./engine/memoryreset";
import {
  applyBootstrap,
  createDoneFilter,
  hasDoneMarker,
  removeBootstrap,
  stripDoneMarker,
} from "./engine/bootstrap";
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

/**
 * 引擎自己退出后自动重拉的退避序列（毫秒）。
 *
 * 为什么要有这个：2026-11-23 21:06 引擎自己退了，窗口一直开着，用户看到的表现是
 * 「QQ 不回话」，而壳完全没意识到引擎已经没了——白等了 2 小时 20 分。
 * 序列用完（5 次）就不再试：反复失败的引擎不该被无限重启，那只会把用户困在
 * 「一直在转圈」里，还刷满日志。
 */
const RESTART_DELAYS_MS: readonly number[] = [2_000, 5_000, 10_000, 20_000, 30_000];
/** 引擎稳定跑这么久之后，把「重试次数」清零——中途真崩了还有额度可用。 */
const STABLE_RESET_MS = 5 * 60_000;
let restartAttempts = 0;
let restartTimer: NodeJS.Timeout | undefined;
let stableTimer: NodeJS.Timeout | undefined;
/**
 * 上一次自动重拉的原因，只给「重拉成功后」用一次。
 *
 * 为什么留着：bootEngine 开头会把 state 清成 starting、成功后又清成 ready，
 * 崩溃提示会被这两次重置抹掉，用户只看到窗口「闪了一下又能说话了」，
 * 不知道刚才掉过线。日志里有，但界面也该留一句。
 */
let lastCrashNote: string | null = null;
/** 当前配置里的默认模型 ref（未配置时为 undefined）。 */
let modelRef: string | undefined;
/** 是否已有可选用的凭据。 */
let keyPresent = false;
/** 正在进行的对话请求，用于「停下」按钮。 */
let activeChat: AbortController | undefined;

/**
 * 会话身份。**这是「它记得你」的唯一开关**。
 *
 * 引擎的 `x-openclaw-session-key` 决定请求落进哪段会话：不给就是一个全新随机会话，
 * 每次说话它都是第一次见你。所以这个值必须持久化——存 userData，
 * 卸载时随应用消失（记忆本体在文档目录，不在这里）。
 *
 * 格式限制（实测自源码）：不能用 `subagent:` / `cron:` / `acp:` 开头，
 * 那是引擎的保留命名空间。其余字符随意。
 */
const SESSION_FILE = "session.json";
/**
 * 桌面窗口和 QQ 私聊**共用同一段会话**（2026-11-23 起）。
 *
 * 以前这里是 `hundun-main`：引擎会把它规范成 `agent:main:hundun-main`，而 QQ 那边
 * 由 `session.dmScope = per-channel-peer` 落进 `agent:main:qqbot:direct:<openid>`，
 * 于是「电脑上说过的」和「手机上说过的」是两段记忆——问它手机上的事，桌面上它不知道。
 *
 * 现在两侧都写到 `agent:main:main`（引擎的标准主会话键，见 `buildAgentMainSessionKey`）。
 * 配套改动：`openclaw.json` 的 `session.dmScope` 改成 `main`，模型名改成 `openclaw/main`
 * （多 agent 下 `openclaw/default` 会被拒：`Multiple agents are configured …`）。
 *
 * 为什么必须带 `agent:` 前缀：实测（2026-11-23）不带前缀的键会让引擎在组装上下文时
 * 走到内部错误分支（流里回 `internal error`），带前缀才正常应答。
 */
const SESSION_KEY = "agent:main:main";
/** 引擎的完整会话键都带这个前缀；只认它，别的当作「上一个人留下的」。 */
const SESSION_KEY_PREFIX = "agent:";

async function readSessionKey(dataDir: string): Promise<string> {
  try {
    const raw = await readFile(join(dataDir, SESSION_FILE), "utf8");
    const parsed = JSON.parse(raw) as { sessionKey?: unknown };
    if (typeof parsed.sessionKey === "string") {
      const stored = parsed.sessionKey.trim();
      // 旧版本存的是 `hundun-main` / `hundun-<uuid>`，没有 `agent:` 前缀。
      // 它们在引擎里是另一段会话，继续用就等于「换了个屋子」，所以一律不用。
      if (stored.startsWith(SESSION_KEY_PREFIX)) return stored;
    }
  } catch {
    // 第一次运行、或文件坏了：用默认 key。坏了不该阻断对话。
  }
  return SESSION_KEY;
}

/**
 * 「从什么时候开始同步另一端的消息」。
 *
 * 两端共用一段会话是 2026-11-23 才做的，之前那段 QQ 会话（`agent:main:qqbot:direct:…`）
 * **不迁过来**（用户明确「不迁，新会话开始」）。换键之后本该是干净的一段，但同一段会话里
 * 可能已经有开发期测试留下的几句话——那不是用户说的，不该出现在对话里。
 * 所以第一次用到这个功能时记一个时间点，只显示这之后的消息。
 * 文件放 dataDir：它是界面行为，不是记忆，卸载可删。
 */
const REMOTE_SINCE_FILE = "remote-sync.json";

async function remoteSince(dataDir: string): Promise<number> {
  const file = join(dataDir, REMOTE_SINCE_FILE);
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as { since?: unknown };
    if (typeof parsed.since === "number" && Number.isFinite(parsed.since)) return parsed.since;
  } catch {
    // 没有这个文件：说明是第一次，下面写一个
  }
  const now = Date.now();
  try {
    await writeFile(file, `${JSON.stringify({ since: now }, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // 写不进去就本次按 now 过滤，下次再试
  }
  return now;
}
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
    const raw = nativeImage.createFromPath(iconPath);
    if (raw.isEmpty()) throw new Error(`托盘图标读不出来：${iconPath}`);
    /*
     * 三平台都常驻托盘（O15，2026-11-17 用户确认），但图标尺寸要按平台给：
     *
     *   macOS   —— 菜单栏高 22pt，图标习惯 16–18pt。直接塞 32px 会顶出菜单栏、
     *              上下被裁掉。这里缩到 18（Retina 下略软，但没有 Mac 实测，
     *              我选择先保证「不被裁」这个会一眼看出来的问题）。
     *   Windows —— 托盘槽 16px（100% DPI）/ 24（150%）/ 32（200%）。32px 交出去
     *              由系统按 DPI 缩，效果可以。
     *   Linux   —— AppIndicator 普遍按 22–24 显示，32px 也能接受。
     */
    const image =
      process.platform === "darwin" ? raw.resize({ width: 18, height: 18 }) : raw;
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
    /*
     * 「点图标」的语义按平台习惯分，不能一刀切：
     *
     *   macOS   —— 设了 contextMenu 之后，单击默认就是弹菜单。此时再绑 click 会把
     *              单击变成「打开窗口」，菜单永远弹不出来，正好和全系统习惯相反。
     *   Windows —— 单击开窗；另有相当比例的人习惯双击，两个事件都绑。
     *              showWindow 是幂等的，重复触发不会开出第二个窗口。
     *   Linux   —— 单击开窗（托盘走 AppIndicator，具体行为随桌面环境略有差异）。
     */
    if (process.platform !== "darwin") {
      tray.on("click", showWindow);
      if (process.platform === "win32") tray.on("double-click", showWindow);
    }
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
    // 界面上「能不能说话」由这两条共同决定：
    //   没有模型 ref → 引擎会退回内置 openai 路由，必然报鉴权错误
    //   没有密钥     → 路由接上了但 provider 拿不到凭据
    // 分开报是为了让用户看到「差哪一步」，而不是笼统一句失败了。
    model: {
      ref: modelRef ?? null,
      keyPresent: keyPresent,
    },
  };
}

/**
 * 引擎在**就绪之后**自己退出了（不是我们停的）。决定：重拉，还是认栽。
 *
 * 判据只有两条：退出码 78（配置不合法）绝不重试——重启一百次还是同一个错，
 * 只会把用户按在反复失败里；其余情况按退避序列重拉，用完额度就停下并说明原因。
 */
function scheduleRestart(code: number | null): void {
  if (quitting || restartTimer) return;

  if (code === 78) {
    state = {
      ...state,
      status: "failed",
      failure: {
        kind: "config-invalid",
        retryable: false,
        userMessage: "配置不合法，陪伴引擎已停止。修好配置再重启，反复重启没有意义。",
      },
    };
    broadcast();
    return;
  }

  const delay = RESTART_DELAYS_MS[restartAttempts];
  if (delay === undefined) {
    const logHint = engine?.logFile ? `日志在 ${engine.logFile}` : "日志在 state/logs/ 下";
    state = {
      ...state,
      status: "failed",
      failure: {
        kind: "crash-loop",
        // 额度用完了，壳不再自动重试（不是「不重试就完蛋」——用户仍可手动点重启）
        retryable: false,
        userMessage: `陪伴引擎连续 ${RESTART_DELAYS_MS.length} 次自己退出，已停止自动重启。${logHint}`,
      },
    };
    broadcast();
    return;
  }

  restartAttempts += 1;
  lastCrashNote = `陪伴引擎刚才自己退出（code=${String(code)}），已自动重启 ${restartAttempts} 次。详情见引擎日志。`;
  state = {
    ...state,
    status: "starting",
    pid: null,
    notice: `陪伴引擎意外退出了（code=${String(code)}），${Math.round(delay / 1000)} 秒后自动重启（第 ${restartAttempts} 次）…`,
  };
  broadcast();

  restartTimer = setTimeout(() => {
    restartTimer = undefined;
    void bootEngine();
  }, delay);
}

/** 引擎就绪：先记「活了多久」，稳定 5 分钟就把重试额度还回来。 */
function markEngineStable(): void {
  if (stableTimer) clearTimeout(stableTimer);
  stableTimer = setTimeout(() => {
    stableTimer = undefined;
    restartAttempts = 0;
  }, STABLE_RESET_MS);
}

async function bootEngine(): Promise<void> {
  if (!paths) return;
  state = { ...emptyState(), status: "starting" };
  broadcast();

  // 模型与凭据状态先读出来：接管分支也要能如实报告「差哪一步」
  try {
    modelRef = await readModelRef(paths.configFile);
    keyPresent = Object.keys(await readSecrets(paths.dataDir)).length > 0;
  } catch {
    modelRef = undefined;
    keyPresent = false;
  }

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

    // 凭据只在 spawn 这一刻进环境变量。改完 key 必须重启引擎，正是因为这个。
    const secrets = await readSecrets(paths.dataDir);
    keyPresent = Object.keys(secrets).length > 0;

    const port = await findFreePort();
    engine = await startEngine({
      paths,
      port,
      token,
      secrets,
      onLog: (line) => {
        sendToWindow("shell:log", line);
      },
      // 就绪之后自己退出 → 自动重拉（见 scheduleRestart）。
      onUnexpectedExit: ({ code }) => {
        scheduleRestart(code);
      },
    });
    state = {
      ...emptyState(),
      status: "ready",
      port,
      pid: engine.pid ?? null,
      // 崩溃提示只消费一次：重拉成功后留一句，之后归位到 seed 的告警
      notice: [lastCrashNote, seed.warnings.join("\n")].filter(Boolean).join("\n") || null,
    };
    lastCrashNote = null;
    broadcast();
    markEngineStable();
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
    // 用户手动重启＝重新给额度，否则之前自动重试用掉的次数会一直压着他。
    restartAttempts = 0;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = undefined;
    }
    if (engine) {
      await engine.stop();
      engine = undefined;
    }
    await bootEngine();
    return currentStatus();
  });

  /**
   * 说一句话。
   *
   * 上下文由渲染层带着历史一起发上来，壳不替它记——这样「界面上看到的」和
   * 「发给模型的」永远是同一份，不会出现两边悄悄分叉。
   *
   * 失败不抛异常而是返回结构化结果：IPC 抛错只剩一条 message，
   * 而我们需要把「缺密钥 / 缺模型 / 引擎没起来」分开展示（three very different fixes）。
   */
  ipcMain.handle("chat:send", async (_event, history: unknown) => {
    if (!paths) return { ok: false as const, kind: "engine" as const, message: "还没初始化完成" };
    if (!state.port) return { ok: false as const, kind: "engine" as const, message: "引擎还没起来" };

    // 渲染层带上来的历史是不可信输入：先过结构闸（role/长度/条数），再过来源闸
    // （assistant 原文必须在本机台账里）。任何一道不过都不发请求。
    const checked = validateOutgoingHistory(history);
    if (!checked.ok) {
      return { ok: false as const, kind: "invalid" as const, message: checked.error };
    }

    const token = await readGatewayToken(paths.configFile);
    if (!token) return { ok: false as const, kind: "auth" as const, message: "读不到网关 token" };

    const sessionKey = await readSessionKey(paths.dataDir);
    const forged = await checkAssistantOrigin(paths, sessionKey, checked.turns);
    if (forged) {
      return { ok: false as const, kind: "invalid" as const, message: forged };
    }
    // BOOTSTRAP 仪式没过时，把仪式正文注入到最后一条用户消息里。
    // 这是副本，界面看到的对话历史不变；用户不会看到这段内部指令。
    const { messages, pending } = await applyBootstrap(paths, checked.turns);
    const filter = createDoneFilter((delta) => sendToWindow("chat:chunk", delta), pending);
    activeChat?.abort();
    const controller = new AbortController();
    activeChat = controller;

    try {
      const raw = await streamChat({
        port: state.port,
        token,
        sessionKey,
        messages,
        signal: controller.signal,
        onDelta: (delta) => filter.push(delta),
      });
      const finished = filter.finish();
      const text = stripDoneMarker(raw);
      // 先把「模型真的说过这句」记进台账，下一轮来源闸才认它。
      await rememberAssistantTurn(paths, sessionKey, text);
      // 模型若在这轮顺手改了 USER.md 的称呼，这里会把它降级为「提议」，不让它自己定稿。
      await reconcileProfile(paths);
      // 模型在正事回复里误写标记也算完成——标记本身是明确的完成意图。
      if (pending && (finished || hasDoneMarker(raw))) {
        await removeBootstrap(paths);
      }
      return { ok: true as const, text };
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        return { ok: false as const, kind: "aborted" as const, message: "停下了" };
      }
      if (error instanceof ChatError) {
        return { ok: false as const, kind: error.kind, message: error.message };
      }
      return { ok: false as const, kind: "engine" as const, message: String(error) };
    } finally {
      if (activeChat === controller) activeChat = undefined;
    }
  });

  ipcMain.on("chat:abort", () => {
    activeChat?.abort();
  });

  /**
   * 对话历史回读 / 落盘。
   *
   * 只搬界面那份 turns（它本就是发给模型的上下文副本），不碰引擎的记忆与会话
   * （D013）。两份历史靠 session key 对齐：重置记忆换了 key，load 就会返回空，
   * 界面自然回到第一次见面的样子，不会出现「记忆清了，界面还挂着旧对话」。
   */
  ipcMain.handle("chat:load", async () => {
    if (!paths) return [];
    try {
      const sessionKey = await readSessionKey(paths.dataDir);
      return await loadChatHistory(paths, sessionKey);
    } catch {
      return [];
    }
  });

  ipcMain.handle("chat:save", async (_event, history: ChatTurn[]) => {
    if (!paths) return { ok: false, error: "paths 尚未初始化" };
    const sessionKey = await readSessionKey(paths.dataDir);
    return saveChatHistory(paths, sessionKey, history);
  });

  /**
   * 另一端说过的话（手机 QQ 那侧）。
   *
   * 和 `chat:load` 是两条线：那条给「本窗口的上下文」，这条给「别处发生了什么」。
   * 只读引擎的转写，不参与上下文组装、不写任何文件（D013）。
   * 读不到就返回空——界面上少一块，而不是报错。
   */
  ipcMain.handle("chat:remote", async (): Promise<RemoteTurn[]> => {
    if (!paths) return [];
    try {
      const sessionKey = await readSessionKey(paths.dataDir);
      const since = await remoteSince(paths.dataDir);
      return readRemoteTurns(paths, sessionKey).filter((turn) => turn.ts >= since);
    } catch {
      return [];
    }
  });

  /**
   * 更正一条 assistant 回复（R1）。
   *
   * 参数只有「第几条 + 新正文」：要改的是哪一条、原文是什么，都以主进程落盘那份为准，
   * 渲染层没法借这个接口改写别的轮次。改完同步写回 chat-history.json 与台账，
   * 下一轮发送带上去的就是更正后的上下文。
   */
  ipcMain.handle(
    "chat:correct",
    async (_event, payload: { index?: unknown; content?: unknown } | null) => {
      if (!paths) return { ok: false, error: "还没初始化完成" };
      const sessionKey = await readSessionKey(paths.dataDir);
      const result = await correctAssistantTurn(paths, sessionKey, payload?.index, payload?.content);
      if (!result.ok) return result;
      const next = typeof payload?.content === "string" ? payload.content : "";
      await replaceAssistantHash(paths, sessionKey, result.oldContent, next);
      await reconcileProfile(paths);
      return result;
    },
  );

  /**
   * 结构化称呼（R3）。
   *
   * get  —— 界面读当前确认值与待确认提议；
   * confirm —— 用户主动确认。主进程会回读对话历史，要求这个名字确实出现在用户说过的话里；
   * dismiss —— 否掉模型提议，不动已确认值。
   */
  ipcMain.handle("profile:get", async () => {
    if (!paths) return null;
    try {
      return await getProfileView(paths);
    } catch {
      return null;
    }
  });

  ipcMain.handle("profile:confirm", async (_event, name: unknown) => {
    if (!paths) return { ok: false, error: "还没初始化完成" };
    const sessionKey = await readSessionKey(paths.dataDir);
    return confirmUserName(paths, sessionKey, name);
  });

  ipcMain.handle("profile:dismiss", async () => {
    if (!paths) return { ok: false };
    return dismissPendingName(paths);
  });

  /**
   * 模型配置：导入、预览、应用、排序（D028）。
   *
   * 用户手上的是一份 opencode 式 JSON（含 {env:}/{file:} 占位符），
   * 引擎认识的是 models.providers 格式。这里做两件事：
   *   preview —— 只解析不落盘，界面每敲一个字都来，必须廉价无副作用；
   *   apply   —— 解析 + 翻译 + 写 openclaw.json + 写 secrets.json + 重启引擎。
   *
   * 密钥纪律：引擎配置里只写 ${ENV} 插值，明文进 secrets.json（0600）。
   */
  ipcMain.handle("model:preview", async (_event, text: string) => {
    let obj: unknown;
    try {
      obj = JSON.parse(text);
    } catch {
      return { ok: false, errors: ["JSON 语法错误"], warnings: [], providers: [], selected: null, chain: [], format: "opencode", converted: null };
    }
    // claude 式配置先转成 opencode 式中间格式，再走同一条解析链。
    // converted 回给界面：编辑器里展示的是中间格式，卡片/排序才有的放矢。
    const { config, warnings: convWarn, format } = ensureOpencode(obj);
    // {env:NAME} 先查进程环境再回退 secrets.json——apply 过之后真值住在 secrets 里，
    // 不回退的话重启后的配置会被误判成「没 key」还弹 401 警告。
    const secrets = await readSecrets(requirePaths().dataDir);
    const r = normalize(config, {
      resolveVar: (kind, name) => {
        if (kind === "env") return process.env[name] ?? secrets[name] ?? "";
        return "";
      },
    });
    return {
      ok: r.ok,
      errors: r.errors,
      warnings: [...convWarn, ...r.warnings],
      providers: r.providers,
      selected: r.selected,
      chain: r.chain,
      format,
      converted: format === "claude" ? config : null,
    };
  });

  ipcMain.handle("model:apply", async (_event, text: string) => {
    const p = requirePaths();
    let obj: unknown;
    try {
      obj = JSON.parse(text);
    } catch {
      return { ok: false, errors: ["JSON 语法错误"], warnings: [] };
    }
    // claude 式先转中间格式：preview 和 apply 必须共用同一个判据，
    // 否则会出现「预览认出来了、应用没认出来」。
    const { config, warnings: convWarn, format } = ensureOpencode(obj);
    const r = applyModelConfig(config, { existingSecrets: await readSecrets(p.dataDir) });
    if (!r.ok) return { ok: false, errors: r.errors, warnings: [...convWarn, ...r.warnings] };

    // 写 secrets（真实密钥）再写引擎配置（插值引用）
    if (Object.keys(r.secrets).length) await writeSecrets(p.dataDir, r.secrets);
    await writeModelProviders(p.configFile, r.providers, r.primaryRef);
    modelRef = await readModelRef(p.configFile);
    keyPresent = Object.keys(r.secrets).length > 0 || Object.values(r.providers).some((pr) => pr.apiKey);

    // 引擎配置变了（尤其 provider 集），必须重启才生效
    if (engine) {
      await engine.stop();
      engine = undefined;
    }
    await bootEngine();
    return { ok: true, warnings: [...convWarn, ...r.warnings], primaryRef: r.primaryRef, cfg: currentStatus(), format };
  });

  ipcMain.handle("model:pick-file", async () => {
    const r = await dialog.showOpenDialog(mainWindow!, {
      title: "导入一份模型配置",
      properties: ["openFile"],
      filters: [
        { name: "JSON 配置", extensions: ["json", "jsonc"] },
        { name: "全部文件", extensions: ["*"] },
      ],
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    const file = r.filePaths[0];
    if (!file) return { ok: false, canceled: true };
    try {
      const raw = await readFile(file, "utf8");
      // JSONC：去 BOM、注释、尾逗号（opencode 吃这些，我们也照做）
      const text = raw
        .replace(/^\uFEFF/, "")
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/,(\s*[}\]])/g, "$1");
      return { ok: true, path: file, name: file.split(/[\\/]/).pop(), text };
    } catch (e) {
      return { ok: false, error: `读不了这个文件：${(e as Error).message}` };
    }
  });

  /** 排序/增删：只改 JSON 对象不写盘，结果回界面走「预览 → 应用」。 */
  ipcMain.handle("model:edit", (_event, payload: { config: unknown; op: string; ref: string; to?: number; models?: Array<{ id: string; name?: string }> }) => {
    const { config, op, ref, to, models } = payload || {};
    let obj: Record<string, unknown>;
    if (typeof config === "string") {
      try { obj = JSON.parse(config) as Record<string, unknown>; }
      catch { return { ok: false, error: "JSON 语法错误" }; }
    } else if (config && typeof config === "object" && !Array.isArray(config)) {
      obj = config as Record<string, unknown>;
    } else {
      return { ok: false, error: "这份配置不是一个对象" };
    }

    let r: { ok: boolean; config?: Record<string, unknown>; error?: string };
    if (op === "move") r = moveModel(obj, ref, to ?? 0);
    else if (op === "add") r = addModel(obj, ref);
    else if (op === "remove") r = removeModel(obj, ref);
    else if (op === "setModels") r = setProviderModels(obj, ref, models ?? []);
    else return { ok: false, error: "不认识的操作：" + op };
    if (!r.ok) return r;

    const pv = normalize(r.config, {});
    return { ok: true, config: r.config, errors: pv.errors, warnings: pv.warnings };
  });

  /**
   * 去该地址拉真实模型列表（GET /v1/models）。
   *
   * claude 式配置天然没有模型列表，只有一个地址 + 一把钥匙——列表在服务端。
   * 这里收配置原文而不是收钥匙：{env:}/{file:} 占位符在主进程解析成真值，
   * 渲染层全程摸不到明文。只发一个只读请求；拉到什么就填什么，拉不到把手写权留给用户。
   */
  ipcMain.handle("model:probe", async (_event, payload: { config: unknown; providerId?: string }) => {
    const { providerId } = payload || {};
    // 与 model:edit 一样兼容两种入参：JSON 字符串或已解析对象
    let raw: unknown = payload?.config;
    if (typeof raw === "string") {
      try { raw = JSON.parse(raw); }
      catch { return { ok: false, models: [], error: "JSON 语法错误" }; }
    }
    const { config: opencode } = ensureOpencode(raw);
    // 与 apply 同一套占位符解析：env 先看进程环境，再回退 secrets.json——
    // apply 过一次之后真值就住在 secrets 里，不在进程环境里。
    const secrets = await readSecrets(requirePaths().dataDir);
    const r = normalize(opencode, {
      resolveVar: (kind, name) => {
        if (kind === "env") return process.env[name] ?? secrets[name] ?? "";
        try { return readFileSync(name, "utf8").trim(); }
        catch { return ""; }
      },
    });
    const prov = r.providers.find((p) => p.id === providerId) ?? r.providers[0];
    if (!prov) return { ok: false, models: [], error: "这份配置里没有可用的 provider" };
    const probed = await probeModels(prov.baseUrl, prov.apiKey);
    return { ...probed, providerId: prov.id };
  });

  /** 设置页 onMounted 时反向加载已保存的 provider 集（D028）。引擎里已配好的模型，编辑器不能是空的。 */
  ipcMain.handle("model:current", async () => {
    const p = requirePaths();
    const saved = await readSavedProviders(p.configFile);
    return { ok: true, providers: saved.providers, primaryRef: saved.primaryRef };
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

  // 开发者选项（D029）：重置记忆。确认弹窗在主进程——渲染层会误触，弹窗不会，
  // 而且「取消」是默认键。人格文件、模型配置、密钥都不动，见 memoryreset.ts。
  ipcMain.handle("dev:reset-memory", async () => {
    const choice = dialog.showMessageBoxSync(mainWindow!, {
      type: "warning",
      title: RESET_NOTICE.title,
      message: RESET_NOTICE.message,
      detail: RESET_NOTICE.detail,
      buttons: RESET_NOTICE.buttons,
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (choice !== 1) return { ok: false, canceled: true, removed: [] };
    const result = await resetMemory(requirePaths());
    // 引擎正在跑：重启让新 session key 立即生效，也把内存里缓存的旧记忆清掉。
    if (result.ok && engine) {
      await engine.stop();
      engine = undefined;
      await bootEngine();
    }
    return result;
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
 * Windows 必须先有 AppUserModelID，否则 `new Notification()` 会被系统静默丢弃。
 *
 * 症状很坑：点了关闭、窗口消失、**一条提示都没有**，用户以为程序崩了。
 * 而「关窗后还在跑」这件事本身就要靠那条提示来交代（D026 的义务），
 * 所以这不是可选设置，是提示能不能送达的前提。
 * 打包后安装器一般会写这个值，但开发期和免安装运行都没有，必须显式设。
 */
if (process.platform === "win32") app.setAppUserModelId("com.hundun.agent.oc");

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
    // 称呼档案：首次启动从 USER.md 迁移已有称呼（旧档案可延续）；同时把旧的
    // 性别化写法改写成中性表述。不阻塞启动。
    void reconcileProfile(paths).catch(() => undefined);
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
  // 退出时先把自动重启的定时器清掉，否则它可能在收尾期间又把引擎拉起来。
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = undefined;
  }
  if (stableTimer) {
    clearTimeout(stableTimer);
    stableTimer = undefined;
  }
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

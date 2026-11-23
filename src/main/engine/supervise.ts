/**
 * 引擎生命周期：起、等就绪、收尾、接管孤儿。
 *
 * 本文件**不 import electron**——它只依赖 node 标准库，所以能脱离图形界面跑
 * （scripts/dev-engine-smoke.mjs 就是直接用它）。这是刻意的：进程管理是这套壳里
 * 最容易出错、也最需要真跑一次的部分。
 *
 * 关键依据（详见 docs/SHELL-SKELETON.md）：
 *   - 就绪判据用 HTTP `GET /readyz`（免鉴权），不抓日志；
 *   - 直接 spawn node，不经 shell（否则 SIGTERM 只送到 shell，引擎留在后台）；
 *   - 收尾 SIGTERM → 10s → SIGKILL，**不沿用上游 315s 的 drain 预算**；
 *   - 退出码 78 = 配置无效，绝不重试。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, statSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { classifyExit, classifyStartupFailure, type EngineFailure } from "./errors";
import type { EnginePaths } from "./paths";

const STARTUP_TIMEOUT_MS = 90_000;
const STOP_TIMEOUT_MS = 10_000;
const LOG_RING_LINES = 200;

export type EngineStatus = "stopped" | "starting" | "ready" | "stopping" | "failed";

export interface RuntimeRecord {
  readonly pid: number;
  readonly port: number;
  readonly startedAt: string;
}

export interface StartOptions {
  readonly paths: EnginePaths;
  readonly port: number;
  readonly token: string;
  /** 首启时带上它：配置不合法也允许启动。仅在用户明确选择时使用（SHELL-SKELETON §3.3）。 */
  readonly allowUnconfigured?: boolean;
  /**
   * 注入给引擎的凭据类环境变量（来自 `userData/secrets.json`，0600）。
   * 走环境变量而不是写进 openclaw.json：配置那份文件用户会打开、会截图，
   * 明文密钥躺进去迟早外泄。环境变量只活在子进程内存里。
   */
  readonly secrets?: Readonly<Record<string, string>>;
  readonly onLog?: (line: string) => void;
  /**
   * 引擎**在就绪之后**自己退出了（不是我们 stop 的）。壳据此决定要不要自动重拉。
   *
   * 为什么必须有这个回调：2026-11-23 21:06 引擎自己退出，窗口还开着，
   * 用户看到的就是「QQ 不回话」，而壳一直不知道引擎已经没了，白等了两个多小时。
   */
  readonly onUnexpectedExit?: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
}

export interface EngineHandle {
  readonly status: EngineStatus;
  readonly port: number;
  readonly pid: number | undefined;
  /** 引擎日志文件路径（按天，见 openEngineLog）。排障时先看它。 */
  readonly logFile: string;
  stop(): Promise<void>;
  logs(): readonly string[];
}

function pushLog(ring: string[], line: string, onLog?: (line: string) => void): void {
  const trimmed = line.replace(/\s+$/, "");
  if (trimmed.length === 0) return;
  ring.push(trimmed);
  if (ring.length > LOG_RING_LINES) ring.shift();
  onLog?.(trimmed);
}

/** `GET /readyz` 200 才算可接话。注意 `/healthz` 更早返回 200，但它只代表 HTTP 活了。 */
export async function probeReady(port: number, timeoutMs = 1500): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/readyz`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function buildEnv(
  paths: EnginePaths,
  port: number,
  secrets: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...secrets,
    OPENCLAW_HOME: paths.engineHome,
    // ⚠️ 只设 OPENCLAW_HOME 不够。实测（2026-11-13）：只给 HOME 时引擎报
    //   `Missing config. Run openclaw setup or set gateway.mode=local`
    // 因为它按「home 下的默认相对路径」去找，我们写的那个位置对不上。
    // docs/help/environment.md 明确写了这两个变量**优先级高于 OPENCLAW_HOME**，
    // 所以显式钉死，不留猜测空间。
    OPENCLAW_STATE_DIR: paths.stateDir,
    OPENCLAW_CONFIG_PATH: paths.configFile,
    // 显式钉死 workspace（D031）。引擎在设了 STATE_DIR 时会把 workspace 解析为
    // state/workspace；这里再给最高优先级的变量，确保壳（重置/仪式/打开文件夹）
    // 和引擎读写的是同一份人格与记忆，不再出现「重置删空目录」的错位。
    OPENCLAW_WORKSPACE_DIR: paths.workspace,
    // 让引擎自己起的子进程、以及壳调用的 CLI 都用同一个 Node（D023）。
    // 只在 nodeBinary 是绝对路径时前置，避免开发期把 "." 塞进 PATH。
  };
  if (isAbsolute(paths.nodeBinary)) {
    const nodeDir = dirname(paths.nodeBinary);
    const existing = env.PATH ?? "";
    env.PATH = existing.length > 0 ? `${nodeDir}${delimiter}${existing}` : nodeDir;
  }
  // 端口也放进环境，便于诊断；实际以命令行参数为准。
  env.OPENCLAW_SHELL_PORT = String(port);
  return env;
}

export async function readRuntimeRecord(path: string): Promise<RuntimeRecord | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<RuntimeRecord>;
    if (typeof parsed.pid === "number" && typeof parsed.port === "number") {
      return { pid: parsed.pid, port: parsed.port, startedAt: parsed.startedAt ?? "" };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * 上一次壳崩了、引擎还活着时，下次启动应该**接管**它，而不是再起一个。
 * 判据：记录的端口上 `/readyz` 仍然 200。返回值非空即表示可以复用。
 */
export async function findAdoptableEngine(path: string): Promise<RuntimeRecord | undefined> {
  const record = await readRuntimeRecord(path);
  if (!record) return undefined;
  if (await probeReady(record.port)) return record;
  return undefined;
}

export async function clearRuntimeRecord(path: string): Promise<void> {
  await rm(path, { force: true });
}

/**
 * 按天建引擎日志文件；同一份超过 5MB 就滚成 `.1`（只留一代，够看死因）。
 *
 * 为什么写这儿而不是 dataDir：它和 `state/logs/stability` 那几个崩溃快照是一类东西，
 * 都属于「引擎自己的运行记录」，放一起排障时不用两头找。
 */
async function openEngineLog(paths: EnginePaths): Promise<string> {
  const dir = join(paths.stateDir, "logs");
  await mkdir(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const file = join(dir, `engine-${day}.log`);
  try {
    if (statSync(file).size > 5 * 1024 * 1024) await rename(file, `${file}.1`);
  } catch {
    // 不存在就是第一次写，正常
  }
  return file;
}

export async function startEngine(options: StartOptions): Promise<EngineHandle> {
  const { paths, port, token } = options;
  const ring: string[] = [];

  await mkdir(paths.engineHome, { recursive: true });
  await mkdir(paths.workspace, { recursive: true });

  // 引擎日志落盘（2026-11-23 加）。此前只进主进程的内存环，引擎一死环就跟着消失，
  // 「为什么死的」永远查不到——21:06 那次就是这样，只能靠文件 mtime 猜死亡时间。
  const logFile = await openEngineLog(paths);
  const sink = createWriteStream(logFile, { flags: "a", mode: 0o600 });
  // 写盘失败（磁盘满、目录被挪走）不该把壳带崩：日志是排障工具，不是生命线，
  // 丢了就退回「只有内存环」。没有这个监听器，WriteStream 的 error 事件会直接抛。
  let sinkBroken = false;
  sink.on("error", () => {
    sinkBroken = true;
  });
  /** 同时进内存环（界面日志面板）与磁盘。 */
  const log = (line: string): void => {
    const trimmed = line.replace(/\s+$/, "");
    if (trimmed.length === 0) return;
    if (!sinkBroken) sink.write(`${new Date().toISOString()} ${trimmed}\n`);
    pushLog(ring, line, options.onLog);
  };

  const args = [
    paths.engineEntry,
    "gateway",
    "run",
    "--bind",
    "loopback",
    "--auth",
    "token",
    "--token",
    token,
    "--port",
    String(port),
  ];
  if (options.allowUnconfigured) args.push("--allow-unconfigured");

  log(`[shell] spawn ${paths.nodeBinary} ${args.join(" ")}`);
  log(`[shell] 引擎日志 ${logFile}`);

  const child: ChildProcess = spawn(paths.nodeBinary, args, {
    env: buildEnv(paths, port, options.secrets),
    stdio: ["ignore", "pipe", "pipe"],
    // 不经 shell：这是信号能直达引擎的前提（SHELL-SKELETON §3.5）。
    shell: false,
    windowsHide: true,
  });

  let status: EngineStatus = "starting";
  let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | undefined;

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) log(line);
  });
  child.stderr?.on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) log(line);
  });

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => {
      exitInfo = { code, signal };
      // ⚠️ 先取快照再改状态：改完再判断就永远是「不是 ready」了。
      const wasReady = status === "ready";
      const stopping = status === "stopping";
      if (!stopping) status = "failed";
      log(`[shell] 引擎退出 code=${String(code)} signal=${String(signal)}${stopping ? "（我们停的）" : ""}`);
      sink.end();
      // 只有「就绪之后自己退出」才通知壳去重拉；启动阶段失败走上面的异常分支。
      if (wasReady && !stopping) options.onUnexpectedExit?.({ code, signal });
      resolve({ code, signal });
    });
    child.once("error", (error) => {
      log(`[shell] spawn error: ${String(error)}`);
      exitInfo = { code: null, signal: null };
      status = "failed";
      sink.end();
      resolve({ code: null, signal: null });
    });
  });

  const stderrTail = (): string =>
    ring
      .filter((line) => !line.startsWith("[shell]"))
      .slice(-40)
      .join("\n");

  // 等就绪：轮询 /readyz，期间一旦进程退出立刻失败。
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let ready = false;
  while (Date.now() < deadline) {
    if (exitInfo) break;
    if (await probeReady(port)) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (!ready) {
    // 收掉再抛，避免留一个半死的进程。
    if (!exitInfo) {
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
      if (!exitInfo) child.kill("SIGKILL");
      await exited.catch(() => undefined);
      const failure: EngineFailure = {
        kind: "startup-timeout",
        retryable: true,
        userMessage: "陪伴引擎启动超时了。",
        detail: `在 ${STARTUP_TIMEOUT_MS} ms 内 /readyz 未就绪\n\n${stderrTail()}`,
      };
      throw Object.assign(new Error(failure.userMessage), { failure, logs: [...ring] });
    }
    const failure = classifyStartupFailure(
      classifyExit(exitInfo.code, exitInfo.signal),
      stderrTail(),
    );
    throw Object.assign(new Error(failure.userMessage), { failure, logs: [...ring] });
  }

  status = "ready";

  const record: RuntimeRecord = {
    pid: child.pid ?? -1,
    port,
    startedAt: new Date().toISOString(),
  };
  await writeFile(paths.runtimeRecord, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 }).catch(
    () => undefined,
  );

  const handle: EngineHandle = {
    get status() {
      return status;
    },
    port,
    logFile,
    get pid() {
      return child.pid;
    },
    logs: () => [...ring],
    async stop() {
      if (status === "stopped" || status === "failed") return;
      status = "stopping";
      log("[shell] SIGTERM");
      child.kill("SIGTERM");

      const graceful = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), STOP_TIMEOUT_MS)),
      ]);

      if (!graceful) {
        log(`[shell] ${STOP_TIMEOUT_MS} ms 内未退出，SIGKILL`);
        child.kill("SIGKILL");
        await exited.catch(() => undefined);
      }

      status = "stopped";
      await clearRuntimeRecord(paths.runtimeRecord);
    },
  };

  return handle;
}

/** 「上次没能正常退出」——启动时用它给用户一句解释，而不是假装一切正常。 */
export async function hadUncleanExit(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  return (await findAdoptableEngine(path)) === undefined;
}

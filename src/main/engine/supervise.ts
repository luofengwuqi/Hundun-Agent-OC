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
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute } from "node:path";
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
  readonly onLog?: (line: string) => void;
}

export interface EngineHandle {
  readonly status: EngineStatus;
  readonly port: number;
  readonly pid: number | undefined;
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

function buildEnv(paths: EnginePaths, port: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCLAW_HOME: paths.engineHome,
    // ⚠️ 只设 OPENCLAW_HOME 不够。实测（2026-11-13）：只给 HOME 时引擎报
    //   `Missing config. Run openclaw setup or set gateway.mode=local`
    // 因为它按「home 下的默认相对路径」去找，我们写的那个位置对不上。
    // docs/help/environment.md 明确写了这两个变量**优先级高于 OPENCLAW_HOME**，
    // 所以显式钉死，不留猜测空间。
    OPENCLAW_STATE_DIR: paths.stateDir,
    OPENCLAW_CONFIG_PATH: paths.configFile,
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

export async function startEngine(options: StartOptions): Promise<EngineHandle> {
  const { paths, port, token } = options;
  const ring: string[] = [];

  await mkdir(paths.engineHome, { recursive: true });
  await mkdir(paths.workspace, { recursive: true });

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

  pushLog(ring, `[shell] spawn ${paths.nodeBinary} ${args.join(" ")}`, options.onLog);

  const child: ChildProcess = spawn(paths.nodeBinary, args, {
    env: buildEnv(paths, port),
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
    for (const line of chunk.split("\n")) pushLog(ring, line, options.onLog);
  });
  child.stderr?.on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) pushLog(ring, line, options.onLog);
  });

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => {
      exitInfo = { code, signal };
      if (status !== "stopping") status = "failed";
      resolve({ code, signal });
    });
    child.once("error", (error) => {
      pushLog(ring, `[shell] spawn error: ${String(error)}`, options.onLog);
      exitInfo = { code: null, signal: null };
      status = "failed";
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
    get pid() {
      return child.pid;
    },
    logs: () => [...ring],
    async stop() {
      if (status === "stopped" || status === "failed") return;
      status = "stopping";
      pushLog(ring, "[shell] SIGTERM", options.onLog);
      child.kill("SIGTERM");

      const graceful = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), STOP_TIMEOUT_MS)),
      ]);

      if (!graceful) {
        pushLog(ring, `[shell] ${STOP_TIMEOUT_MS} ms 内未退出，SIGKILL`, options.onLog);
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

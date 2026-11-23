/**
 * 引擎重拉之后，把被断路器压住的通道补起来。
 *
 * 为什么单独一个文件、以及为什么只在「壳自己发起重拉」之后才做：
 *
 * 引擎**自己有断路器**（`dist/gateway-boot-lifecycle.kernel-*.mjs`）：state 库里
 * `gateway_boot_lifecycle` 表记每一次启动，5 分钟（`GATEWAY_BOOT_LOOP_WINDOW_MS`）内
 * 攒够 3 次（`GATEWAY_BOOT_LOOP_UNCLEAN_THRESHOLD`）「不干净启动」，它就跳闸，
 * 跳闸后压住的**不是网关本身，是所有通道的自动启动**：
 *
 *     [qqbot] channel autostart suppressed by crash-loop breaker; refusing automatic start
 *
 * 后果很具体：引擎回来了、`/readyz` 是 200、界面显示一切正常，但 QQ 一条都不回——
 * 和用户 2026-11-23 21:06 那次看到的症状完全一样，只是成因不同。
 *
 * 壳的退避序列（2/5/10/20/30 秒）全落在那个 5 分钟窗口内，所以「崩 3 次后重拉成功」
 * 这个组合一定会撞上它。因此重拉成功不等于服务恢复，还得看通道。
 *
 * 边界（用户 2026-11-23 选定「条件自动补」）：
 *   - 只有**壳自己发起的重拉**（`scheduleRestart` 或界面上的「重启引擎」）才补；
 *   - 必须引擎已就绪（`/readyz` 200）之后才查；
 *   - 只拉 `enabled && configured && !running` 的通道，正在跑的一律不碰；
 *   - 每次补启动都写进引擎日志，不静默。
 *
 * 不做的：把这个逻辑挂到「每次启动」上。那等于壳长期替引擎判断该不该绕过断路器，
 * 引擎想拦也拦不住——它拦的正是「一个反复崩的东西不该无限重试」这件事。
 */
import { spawn } from "node:child_process";
import type { EnginePaths } from "./paths";

/** 单次 CLI 调用的上限。网关在环回口，正常几秒；给足余量但不无限等。 */
const CALL_TIMEOUT_MS = 20_000;

/**
 * 引擎就绪到通道真正起来之间有几秒空档。等一会儿再查，否则会把「正在启动」
 * 误判成「被压住了」，白拉一次。
 */
const SETTLE_MS = 6_000;

interface CliResult {
  readonly code: number | null;
  readonly out: string;
  readonly err: string;
}

/** 跑一次引擎 CLI。用 spawn 而不是 exec：参数里有 JSON，不经过 shell 就没有转义问题。 */
function runCli(
  paths: EnginePaths,
  port: number,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<CliResult> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let done = false;
    const finish = (code: number | null): void => {
      if (done) return;
      done = true;
      resolve({ code, out, err });
    };

    const child = spawn(paths.nodeBinary, [paths.engineEntry, ...args], {
      // CLI 默认按配置里的端口找网关（18789），而壳是用 `--port` 另起的，
      // 不显式给这个变量就会连到一个不存在的网关然后报 ECONNREFUSED。
      env: { ...env, OPENCLAW_GATEWAY_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, CALL_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: unknown) => {
      out += String(chunk);
    });
    child.stderr?.on("data", (chunk: unknown) => {
      err += String(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      err += String(error);
      finish(null);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      finish(code);
    });
  });
}

/** CLI 会先打印一行 `Gateway call: xxx`，JSON 从第一个 `{` 开始。 */
function jsonOf(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  try {
    return JSON.parse(text.slice(start)) as unknown;
  } catch {
    return undefined;
  }
}

interface ChannelEntry {
  readonly enabled?: boolean;
  readonly configured?: boolean;
  readonly running?: boolean;
  readonly connected?: boolean;
}

export interface RecoverOptions {
  readonly paths: EnginePaths;
  readonly port: number;
  /** 与引擎子进程同一份环境（`buildEngineEnv` 的输出）。 */
  readonly env: NodeJS.ProcessEnv;
  /** 就绪之后等多久再查，默认 SETTLE_MS。测试时可传 0。 */
  readonly settleMs?: number;
}

/**
 * 查一遍通道，把该跑没跑的拉起来。返回给日志用的若干行（没有可说的就返回空数组）。
 *
 * 不抛异常：这是「引擎已经起来了」之后的锦上添花，失败不该把状态改成 failed。
 */
export async function recoverChannels(options: RecoverOptions): Promise<readonly string[]> {
  const { paths, port, env } = options;
  const settle = options.settleMs ?? SETTLE_MS;
  if (settle > 0) await new Promise((resolve) => setTimeout(resolve, settle));

  const status = await runCli(paths, port, ["gateway", "call", "channels.status"], env);
  const parsed = jsonOf(status.out) as { channels?: Record<string, ChannelEntry> } | undefined;
  if (!parsed?.channels) {
    const why = (status.err || status.out).trim().split("\n").slice(-3).join(" / ").slice(0, 400);
    return [`[shell] 通道状态读不出来，本次不补启动：${why || `exit=${String(status.code)}`}`];
  }

  const idle = Object.entries(parsed.channels)
    .filter(([, entry]) => entry.enabled !== false && entry.configured !== false && entry.running !== true)
    .map(([id]) => id);

  if (idle.length === 0) return [];

  const lines: string[] = [];
  for (const id of idle) {
    const started = await runCli(
      paths,
      port,
      ["gateway", "call", "channels.start", "--params", JSON.stringify({ channel: id })],
      env,
    );
    const result = jsonOf(started.out) as { started?: boolean; outcome?: { status?: string } } | undefined;
    if (result?.started === true) {
      lines.push(`[shell] 通道 ${id} 自动补启动：已交给引擎（${result.outcome?.status ?? "ok"}）`);
    } else {
      const why = (started.err || started.out).trim().split("\n").slice(-3).join(" / ").slice(0, 400);
      lines.push(`[shell] 通道 ${id} 自动补启动失败：${why || `exit=${String(started.code)}`}`);
    }
  }
  return lines;
}

/**
 * 挑一个空闲端口。
 *
 * 为什么不复用上游默认的 18789：用户很可能同时开着官方 CLI / Control UI。
 * 抢端口会导致「我们起不来」或「把用户的进程杀掉」，后者更糟——所以壳
 * **绝不使用 `--force`**（它会杀掉占用目标端口的任何进程，见 SHELL-SKELETON §3.5）。
 *
 * 做法：从 base 往上试，逐个尝试在 127.0.0.1 上 bind；能 bind 就立刻释放并返回。
 * 存在极小的 TOCTOU 窗口（探测与真正 bind 之间被别人抢走），
 * 因此引擎启动失败时允许重试一次换端口，而不是把失败直接抛给用户。
 */
import { createServer } from "node:net";

const LOOPBACK = "127.0.0.1";

function tryBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ port, host: LOOPBACK, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

export interface FindFreePortOptions {
  /** 起始端口，默认 18890——刻意避开上游默认的 18789。 */
  readonly base?: number;
  /** 最多往上试多少个，默认 64。 */
  readonly span?: number;
}

export async function findFreePort(options: FindFreePortOptions = {}): Promise<number> {
  const base = options.base ?? 18890;
  const span = options.span ?? 64;
  for (let offset = 0; offset < span; offset += 1) {
    const port = base + offset;
    if (await tryBind(port)) return port;
  }
  throw new Error(`在 ${base}–${base + span - 1} 范围内找不到空闲端口`);
}

/** 指定端口是否可用（用于判断上次记录的端口还能不能用）。 */
export async function isPortFree(port: number): Promise<boolean> {
  return tryBind(port);
}

/**
 * 模型凭据的落点与读写。
 *
 * **为什么放 `userData` 而不是记忆目录**（这一条不能改）：
 *   1. 记忆目录会被「导出记忆」打成 zip 放桌面（O13），凭据一旦进去就跟着被导出；
 *   2. 记忆目录在文档下，容易被 OneDrive / iCloud 同步（O14），密钥会跟着上云；
 *   3. 记忆目录的设计语义是「卸载也保留」，而密钥应当随应用一起消失。
 *
 * 落成 `secrets.json`（0600）+ 启动引擎时注入环境变量。
 * 为什么不写进 openclaw.json：那份配置是要给用户看、给用户改的，里面躺明文密钥迟早被截图发出去。
 * 环境变量只在子进程内存里，不落盘。
 */
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** 我们允许注入给引擎的环境变量形状。只收这种名字，别的一律不理，防止把 PATH 之类搞坏。 */
const ENV_NAME = /^[A-Z][A-Z0-9_]{2,63}$/;

export function secretsPath(dataDir: string): string {
  return join(dataDir, "secrets.json");
}

export async function readSecrets(dataDir: string): Promise<Record<string, string>> {
  try {
    const raw = await readFile(secretsPath(dataDir), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (ENV_NAME.test(key) && typeof value === "string" && value.length > 0) out[key] = value;
    }
    return out;
  } catch {
    // 不存在、坏 JSON、权限不对——一律当成「没有凭据」，不抛。
    // 这里抛错会让整个启动流程挂掉，而实际情况往往只是第一次运行。
    return {};
  }
}

export async function writeSecret(
  dataDir: string,
  name: string,
  value: string,
): Promise<Record<string, string>> {
  if (!ENV_NAME.test(name)) throw new Error(`不合法的环境变量名：${name}`);
  const current = await readSecrets(dataDir);
  const next = { ...current };
  if (value.trim().length === 0) delete next[name];
  else next[name] = value.trim();

  const path = secretsPath(dataDir);
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  // writeFile 的 mode 只在**新建**时生效，已存在的文件不会改权限，所以显式再来一次。
  await chmod(path, 0o600);
  return next;
}

/**
 * 批量写入（导入一份配置可能带来多个 provider 的 key）。
 * 空值跳过、非空覆盖；不会清掉没提到的键——导入不该抹掉用户手动加的别的 key。
 */
export async function writeSecrets(
  dataDir: string,
  incoming: Readonly<Record<string, string>>,
): Promise<Record<string, string>> {
  const current = await readSecrets(dataDir);
  const next = { ...current };
  for (const [name, value] of Object.entries(incoming)) {
    if (!ENV_NAME.test(name)) continue;
    if (typeof value === "string" && value.trim().length > 0) next[name] = value.trim();
  }
  const path = secretsPath(dataDir);
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return next;
}

/** 哪些变量名算「已配置凭据」。用于界面上判断要不要提示去填 key。 */
export function hasAnySecret(secrets: Record<string, string>, names: readonly string[]): boolean {
  return names.some((name) => typeof secrets[name] === "string" && secrets[name].length > 0);
}

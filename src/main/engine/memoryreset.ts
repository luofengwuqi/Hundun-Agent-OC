/**
 * 开发者选项：重置记忆（D029）。
 *
 * 模仿 HundunAgent 的 D100「开发者 → 初始化应用」，但按我们的目录结构调整：
 * HundunAgent 删的是整个身份目录（人格模板跟着重种），我们这里人格文件是
 * 用户亲手调过的（SOUL/IDENTITY/USER/AGENTS），绝不能洗掉。所以只删两样：
 *   1. workspace/memory/  —— 记忆日志、dreaming、.dreams
 *   2. workspace/DREAMS.md —— 梦日记
 * 会话 key 换新的，引擎那边就是全新会话（旧会话数据还留在 SQLite 里，
 * 只是不再被这个 key 读到——可找回）。
 *
 * 三道保险（照 HundunAgent resetLife 的路径白名单思路）：
 *   1. 主进程系统弹窗确认，默认「取消」——渲染层按钮会误触，弹窗不会；
 *   2. 删除前先备份到应用数据目录（备份不被引擎读，卸载可删）；
 *   3. 目标路径硬校验：必须是 paths.workspace 下的 memory 目录 / DREAMS.md，
 *      名字对不上就拒绝删，绝不递归删 workspace 本身。
 */
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import type { EnginePaths } from "./paths";
import { BOOTSTRAP_FILE, ensureBootstrap } from "./bootstrap";

const SESSION_FILE = "session.json";
const SESSION_PREFIX = "hundun-";

export interface MemoryResetResult {
  ok: boolean;
  error?: string;
  /** 备份所在目录（应用数据目录下，引擎不读）。取消时为空。 */
  backupDir?: string;
  /** 删掉的相对路径列表，给用户看清楚删了什么。 */
  removed: string[];
  /** 仪式是否重新种下（回到第一次见面）。 */
  bootstrapRestored?: boolean;
}

/** 只删这两个明确目标；路径对不上就抛错。 */
function assertTargets(paths: EnginePaths): { memoryDir: string; dreamsFile: string; backupDir: string } {
  const workspace = resolve(paths.workspace);
  const home = resolve(paths.engineHome);
  // workspace 必须在 engineHome 下面，且名字就叫 workspace
  if (basename(workspace) !== "workspace" || !workspace.startsWith(home + sep)) {
    throw new Error(`重置目标不对，拒绝删除：${workspace}`);
  }
  const memoryDir = join(workspace, "memory");
  if (basename(memoryDir) !== "memory") throw new Error("记忆目录名不对");
  const dreamsFile = join(workspace, "DREAMS.md");
  if (basename(dreamsFile) !== "DREAMS.md") throw new Error("梦日记文件名不对");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = join(resolve(paths.dataDir), `memory-backup-${stamp}`);
  if (!backupDir.startsWith(resolve(paths.dataDir) + sep)) throw new Error("备份路径不对");
  return { memoryDir, dreamsFile, backupDir };
}

/** 备份一个路径（目录递归拷）到备份目录下。用 fs.cp 兼容目录与文件。 */
async function backup(target: string, dest: string): Promise<void> {
  const { cp, stat } = await import("node:fs/promises");
  const info = await stat(target).catch(() => null);
  if (!info) return;
  if (info.isDirectory()) await cp(target, dest, { recursive: true });
  else await copyFile(target, dest);
}

/**
 * 执行重置。调用方（主进程 IPC）必须先弹窗确认。
 * 备份成功才删；备份失败直接返回错误，不动原文件。
 */
export async function resetMemory(paths: EnginePaths): Promise<MemoryResetResult> {
  const removed: string[] = [];
  try {
    // 校验也放进 try：路径不对时返回 {ok:false,error}，不让异常穿过 IPC 层。
    const { memoryDir, dreamsFile, backupDir } = assertTargets(paths);
    await mkdir(backupDir, { recursive: true, mode: 0o700 });
    await backup(memoryDir, join(backupDir, "memory"));
    await backup(dreamsFile, join(backupDir, "DREAMS.md"));
    // 会话 key 也留一份，想找回旧会话时把 session.json 从备份恢复即可
    const sessionPath = join(resolve(paths.dataDir), SESSION_FILE);
    const sessionRaw = await readFile(sessionPath, "utf8").catch(() => "{}");
    await writeFile(join(backupDir, SESSION_FILE), sessionRaw, { mode: 0o600 });
    // 仪式文件也留一份；重置后我们会重新种一份新的。
    const workspace = resolve(paths.workspace);
    await backup(join(workspace, BOOTSTRAP_FILE), join(backupDir, BOOTSTRAP_FILE));

    // 备份齐了才开始删。force:true：本来就没有记忆文件也算成功（幂等）。
    await rm(memoryDir, { recursive: true, force: true });
    removed.push("workspace/memory/");
    await rm(dreamsFile, { force: true });
    removed.push("workspace/DREAMS.md");
    // 旧仪式也要清掉，下面才会无条件重种一份——不然「重置」完仪式还是旧的。
    await rm(join(workspace, BOOTSTRAP_FILE), { force: true });
    removed.push("workspace/BOOTSTRAP.md");

    // 换新 session key：引擎下次对话就是全新会话，不再带着旧记忆。
    // SESSION_PREFIX + uuid：和默认 hundun-main 同形状，readSessionKey 直接认。
    const freshKey = `${SESSION_PREFIX}${randomUUID()}`;
    await mkdir(resolve(paths.dataDir), { recursive: true });
    await writeFile(sessionPath, `${JSON.stringify({ sessionKey: freshKey }, null, 2)}\n`, { mode: 0o600 });

    // 重新种下 BOOTSTRAP：下一次对话它会重新认识你，而不是直接拿来路不明的记忆接着聊。
    const bootstrapRestored = await ensureBootstrap(paths);

    return { ok: true, backupDir, removed, bootstrapRestored };
  } catch (error) {
    return { ok: false, error: (error as Error).message || String(error), removed };
  }
}

/** 给界面显示的文案：会删什么、不删什么。 */
export const RESET_NOTICE = {
  title: "重置记忆",
  message: "清空馄饨的记忆，回到第一次见面的状态？",
  detail:
    "会删掉记忆日志、梦日记，并换一个新会话——它不再记得你们聊过什么。" +
    "下次见面会重新走一遍认识的流程。人格文件（SOUL/IDENTITY/USER/AGENTS）、模型配置和密钥都保留。\n\n" +
    "删之前会在应用数据目录留一份备份，想找回可以拿回来。",
  buttons: ["取消", "清空记忆并重置"],
};

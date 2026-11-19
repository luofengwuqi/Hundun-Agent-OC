/**
 * 对话历史落盘：让「重新进入」时界面能把上次聊过的显示出来。
 *
 * 边界（D013）：这里只存**界面自己那份 turns**——它的内容本来就是「发给模型的上下文」
 * 的唯一副本（见 App.vue 的注释），落盘只是让进程重启后能把它读回来，不是在壳里
 * 另造一套会话/记忆系统。引擎侧「它记得你」仍由 session key + workspace/memory/ 负责。
 * 两份各有职责：这里存「说过的话」（回显 + 续接上下文），引擎存「记住的你」（人格化回应）。
 *
 * 落点（D024）：engineHome（文档目录），与人格/记忆同命运——卸载不会删，备份一并带走。
 * 不放 dataDir：那是卸载可删的缓存，历史放那里等于卸载后「界面失忆」。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EnginePaths } from "./paths";
import type { ChatTurn } from "./chat";

const HISTORY_FILE = "chat-history.json";
const FORMAT_VERSION = 1;
/**
 * 只留最近这些轮，防止文件无限膨胀。
 * 取值理由：现有 send() 把整份 turns 作为上下文发给模型，窗口再大也有上限；
 * 200 轮足够覆盖任何一次连贯对话，再往前的轮次留在引擎的 SQLite 里（换 key 可找回）。
 */
const MAX_TURNS = 400;

interface HistoryFile {
  version: number;
  savedAt: string;
  /** 写这份历史时的会话 key。读的时候对不上就整份作废（重置记忆换了 key）。 */
  sessionKey: string;
  turns: ChatTurn[];
}

export interface ChatHistoryResult {
  ok: boolean;
  error?: string;
}

function historyPath(paths: EnginePaths): string {
  return join(paths.engineHome, HISTORY_FILE);
}

/** 只留 user / assistant 且非空的轮次：system 消息与流式空占位都不该落盘。 */
function clean(turns: readonly ChatTurn[]): ChatTurn[] {
  const out: ChatTurn[] = [];
  for (const turn of turns) {
    if (turn.role !== "user" && turn.role !== "assistant") continue;
    if (typeof turn.content !== "string" || turn.content.length === 0) continue;
    out.push({ role: turn.role, content: turn.content });
  }
  return out.slice(-MAX_TURNS);
}

/**
 * 回读历史。任何异常（文件不存在、坏 JSON、版本不符、key 不符）都返回空，
 * 不向上抛——「读不出历史」应该退化成第一次见面的样子，而不是让应用起不来。
 */
export async function loadChatHistory(paths: EnginePaths, currentSessionKey: string): Promise<ChatTurn[]> {
  let raw: string;
  try {
    raw = await readFile(historyPath(paths), "utf8");
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const file = parsed as Partial<HistoryFile>;
  // 重置记忆（D029）会换新 session key。对不上就说明这份历史属于「上一个人」，
  // 不该再出现在界面上——留着文件不删，用户想找回还有机会。
  if (file.version !== FORMAT_VERSION) return [];
  if (file.sessionKey !== currentSessionKey) return [];
  if (!Array.isArray(file.turns)) return [];
  return clean(file.turns);
}

/**
 * 落盘当前对话。原子写：先写临时文件再 rename，写到一半崩了也不会毁掉上一份完整历史。
 * 会话 key 一起存进去，回读时据此判断这份历史是否还属于当前会话。
 */
export async function saveChatHistory(
  paths: EnginePaths,
  sessionKey: string,
  turns: readonly ChatTurn[],
): Promise<ChatHistoryResult> {
  try {
    const file = historyPath(paths);
    await mkdir(dirname(file), { recursive: true });
    const payload: HistoryFile = {
      version: FORMAT_VERSION,
      savedAt: new Date().toISOString(),
      sessionKey,
      turns: clean(turns),
    };
    const tmp = `${file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, file);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message || String(error) };
  }
}

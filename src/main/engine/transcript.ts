/**
 * 从引擎的会话转写里读「不是在这个窗口里发生的那些话」。
 *
 * 为什么需要它：2026-11-23 起桌面窗口和 QQ 私聊**共用一段会话**（`agent:main:main`，
 * 见 main.ts 的 SESSION_KEY）。记忆合一了，但界面的历史来自本模块之外的那份
 * `chat-history.json`——它只记这个窗口发出去的话，手机上说的话它不知道。
 * 所以这里直接读引擎的转写，把手机那侧补上来。
 *
 * 边界（D013 / D031）：**只读，不写**。这里不参与上下文组装，也不改引擎的历史；
 * 它只是把引擎已经记下的东西搬给界面看。渲染层拿到的独立于本地 turns。
 *
 * 读法（2026-11-23 实测，不是照文档抄的）：
 *   session_nodes.session_key → current_session_id
 *   transcript_events(session_id, seq, message_role, event_json)
 * 只有 `message_role IN ('user','assistant')` 的行才算「说过的话」；工具调用、
 * 思考块、会话元信息都在别的行里，或者在 content 数组的非 text 块里。
 *
 * 两个必须处理的脏东西：
 *   1. **压缩存储**：较大的事件存在 `event_zstd` 里（`event_json` 为空）。这种行直接跳过，
 *      不解压——显示少一条好过在这里引一个 zstd 依赖。
 *   2. **包装消息**：桌面端每次请求都把「全量历史 + 新一句」发给引擎，引擎会把非最后
 *      那部分包成一条 user 消息存下来，形如
 *        `[Chat messages since your last reply - for context] … [Current message - respond to this] User: 正文`
 *      原样显示会很难看，也会和本地历史里的同一段重复。所以只取 `[Current message]` 之后那部分。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EnginePaths } from "./paths";

export interface RemoteTurn {
  readonly role: "user" | "assistant";
  readonly content: string;
  /** 毫秒时间戳，取自引擎事件。界面可以用它显示时间。 */
  readonly ts: number;
}

/** 包装消息的两个标记，实测原文（2026-11-23，引擎 2026.11.3）。 */
const WRAPPER_HEAD = "[Chat messages since your last reply";
const WRAPPER_CURRENT = "[Current message - respond to this]";
/** 界面只需要最近这些条；再往前的留给引擎自己的记忆检索。 */
const MAX_TURNS = 60;

/** `agent:main:xxx` → `main`。取不到就按 main 处理。 */
function agentIdOf(sessionKey: string): string {
  const parts = sessionKey.split(":");
  if (parts[0] === "agent" && parts[1]) return parts[1];
  return "main";
}

function dbPathOf(paths: EnginePaths, agentId: string): string {
  return join(paths.stateDir, "agents", agentId, "agent", "openclaw-agent.sqlite");
}

/** 把 content 归一成正文：字符串直接用，块数组只拼 text 块（跳过 thinking / tool_use）。 */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === "text" && typeof b.text === "string") out.push(b.text);
  }
  return out.join("");
}

/** 只留 `[Current message]` 之后的那句；不是包装消息就原样返回。 */
function unwrap(text: string): string {
  if (!text.startsWith(WRAPPER_HEAD)) return text;
  const at = text.lastIndexOf(WRAPPER_CURRENT);
  if (at < 0) return text;
  const rest = text.slice(at + WRAPPER_CURRENT.length).trim();
  return rest.startsWith("User:") ? rest.slice("User:".length).trim() : rest;
}

/**
 * 读一段会话里最近的消息。任何异常都返回空数组——「同步看不到」应该退化成
 * 「只有本窗口的历史」，不能让它把界面拖崩。
 */
export function readRemoteTurns(
  paths: EnginePaths,
  sessionKey: string,
  limit: number = MAX_TURNS,
): RemoteTurn[] {
  const file = dbPathOf(paths, agentIdOf(sessionKey));
  if (!existsSync(file)) return [];

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });

    const node = db
      .prepare("SELECT current_session_id FROM session_nodes WHERE session_key = ?")
      .get(sessionKey) as { current_session_id?: unknown } | undefined;
    const sessionId = typeof node?.current_session_id === "string" ? node.current_session_id : "";
    if (!sessionId) return [];

    // 先按下标倒着取 N 条再翻回正序：只要最近这些，不要全量。
    const rows = db
      .prepare(
        [
          "SELECT seq, message_role, event_json, created_at",
          "FROM transcript_events",
          "WHERE session_id = ? AND message_role IN ('user', 'assistant') AND event_json IS NOT NULL",
          "ORDER BY seq DESC LIMIT ?",
        ].join(" "),
      )
      .all(sessionId, limit) as Array<{
      seq: number;
      message_role: unknown;
      event_json: unknown;
      created_at: unknown;
    }>;

    const turns: RemoteTurn[] = [];
    for (const row of rows.reverse()) {
      const role = row.message_role === "assistant" ? "assistant" : row.message_role === "user" ? "user" : null;
      if (!role) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(row.event_json));
      } catch {
        continue;
      }
      const message = (parsed as { message?: { content?: unknown } } | null)?.message;
      const text = unwrap(textOf(message?.content)).trim();
      // 空的 assistant 事件很常见（这一轮只调了工具，正文才刚开头）。
      if (!text) continue;
      const ts = typeof row.created_at === "number" ? row.created_at : Date.now();
      turns.push({ role, content: text, ts });
    }
    return turns;
  } catch {
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      // 关不掉就算了，进程退出会带走。
    }
  }
}

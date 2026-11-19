/**
 * 对话历史守卫：把渲染层带上来的 history 当成**不可信输入**核对一遍再送引擎。
 *
 * 为什么要有这一层：界面那份 turns 就是发给模型的上下文（见 chathistory.ts 的边界说明），
 * 但它来自渲染进程。渲染进程能改自己的内存，IPC 也是信任边界——不核对就等于让任何
 * 能跑在渲染层里的脚本伪造「模型说过的话」，或者塞 system 指令进上下文。
 *
 * 两道闸：
 *   1. 结构闸：role 只收 user / assistant，条数、单条字数、总字数都有上限。
 *   2. 来源闸：每条 assistant 原文必须能在本机台账里找到（台账只存 sha256，不存原文）。
 *      台账由主进程在**真正收到模型回复时**写入；已有 chat-history.json 首次迁移时整份登记。
 *      因此渲染层新编一条 assistant 消息会在这里被拒。
 *
 * 只做校验与台账，不改写任何内容。
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EnginePaths } from "./paths";
import type { ChatTurn } from "./chat";
import { loadChatHistory, MAX_TURN_CHARS, MAX_TURNS } from "./chathistory";

const LEDGER_FILE = "chat-ledger.json";
const LEDGER_VERSION = 1;
/** 台账只留最近这些条摘要，避免文件无限膨胀。 */
const MAX_LEDGER_HASHES = 1200;

/** 与 chathistory.ts 的落盘上限一致；发送路径单独再卡一次。 */
export const MAX_SEND_TURNS = MAX_TURNS;
export const MAX_TURN_CHARS_PER_SEND = MAX_TURN_CHARS;
export const MAX_TOTAL_CHARS = 120_000;

export interface HistoryCheckOk {
  readonly ok: true;
  readonly turns: ChatTurn[];
}

export interface HistoryCheckFail {
  readonly ok: false;
  readonly error: string;
}

export type HistoryCheck = HistoryCheckOk | HistoryCheckFail;

/**
 * 结构校验 + 白名单。返回的是**重新构造**的 turn（只带 role/content），
 * 不让渲染层塞进来的额外字段原样流进引擎请求体。
 */
export function validateOutgoingHistory(input: unknown): HistoryCheck {
  if (!Array.isArray(input)) {
    return { ok: false, error: "对话历史格式不对（不是数组），已拒绝发送。" };
  }
  if (input.length === 0) {
    return { ok: false, error: "没有可发送的消息。" };
  }
  if (input.length > MAX_SEND_TURNS) {
    return {
      ok: false,
      error: `对话历史太长了（${input.length} 条，最多 ${MAX_SEND_TURNS} 条）。清空一部分再说。`,
    };
  }

  const turns: ChatTurn[] = [];
  let total = 0;
  for (let i = 0; i < input.length; i += 1) {
    const raw = input[i] as unknown;
    if (!raw || typeof raw !== "object") {
      return { ok: false, error: `第 ${i + 1} 条消息结构不对，已拒绝发送。` };
    }
    const item = raw as { role?: unknown; content?: unknown };
    if (item.role === "system") {
      return {
        ok: false,
        error: "对话历史里出现了不允许的角色「system」，已拒绝发送。只接受 user / assistant。",
      };
    }
    if (item.role !== "user" && item.role !== "assistant") {
      return {
        ok: false,
        error: `第 ${i + 1} 条消息的角色不是 user / assistant，已拒绝发送。`,
      };
    }
    if (typeof item.content !== "string" || item.content.length === 0) {
      return { ok: false, error: `第 ${i + 1} 条消息内容为空或格式不对，已拒绝发送。` };
    }
    if (item.content.length > MAX_TURN_CHARS_PER_SEND) {
      return {
        ok: false,
        error: `第 ${i + 1} 条消息超过 ${MAX_TURN_CHARS_PER_SEND} 字，已拒绝发送。`,
      };
    }
    total += item.content.length;
    if (total > MAX_TOTAL_CHARS) {
      return {
        ok: false,
        error: `对话历史总长度超过 ${MAX_TOTAL_CHARS} 字，已拒绝发送。清空一部分再说。`,
      };
    }
    turns.push({ role: item.role, content: item.content });
  }
  return { ok: true, turns };
}

interface LedgerFile {
  version: number;
  sessionKey: string;
  hashes: string[];
}

interface Ledger {
  version: number;
  sessionKey: string;
  hashes: string[];
}

export function hashOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function ledgerPath(paths: EnginePaths): string {
  return join(paths.dataDir, LEDGER_FILE);
}

async function readLedger(paths: EnginePaths): Promise<Ledger | null> {
  try {
    const raw = await readFile(ledgerPath(paths), "utf8");
    const parsed = JSON.parse(raw) as Partial<LedgerFile>;
    if (parsed.version !== LEDGER_VERSION) return null;
    if (typeof parsed.sessionKey !== "string") return null;
    if (!Array.isArray(parsed.hashes)) return null;
    return {
      version: LEDGER_VERSION,
      sessionKey: parsed.sessionKey,
      hashes: parsed.hashes.filter((h): h is string => typeof h === "string"),
    };
  } catch {
    return null;
  }
}

async function writeLedger(paths: EnginePaths, ledger: Ledger): Promise<void> {
  const file = ledgerPath(paths);
  await mkdir(paths.dataDir, { recursive: true });
  const payload: LedgerFile = {
    version: LEDGER_VERSION,
    sessionKey: ledger.sessionKey,
    hashes: ledger.hashes.slice(-MAX_LEDGER_HASHES),
  };
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  await rename(tmp, file);
}

/**
 * 取当前会话台账。没有（或 key 不符）时从已落盘历史迁移一次：
 * 升级前写下的 assistant 原文本来就在 chat-history.json 里，把它们当作既有事实登记，
 * 不做任何改写。迁移只发生一次。
 */
async function ensureLedger(paths: EnginePaths, sessionKey: string): Promise<Ledger> {
  const current = await readLedger(paths);
  if (current && current.sessionKey === sessionKey) return current;

  const existing = await loadChatHistory(paths, sessionKey);
  const hashes: string[] = [];
  for (const turn of existing) {
    if (turn.role === "assistant") hashes.push(hashOf(turn.content));
  }
  const ledger: Ledger = { version: LEDGER_VERSION, sessionKey, hashes: dedupe(hashes) };
  try {
    await writeLedger(paths, ledger);
  } catch {
    // 台账写不进去不该让对话整段不可用：本次用内存里的结果，下次再试。
  }
  return ledger;
}

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * 来源闸：每条 assistant 消息都必须是本机真的产出过的原文。
 * 返回 null 表示通过，否则返回给用户看的原因。
 */
export async function checkAssistantOrigin(
  paths: EnginePaths,
  sessionKey: string,
  turns: readonly ChatTurn[],
): Promise<string | null> {
  const ledger = await ensureLedger(paths, sessionKey);
  const known = new Set(ledger.hashes);
  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i];
    if (turn?.role !== "assistant") continue;
    const hash = hashOf(turn.content);
    if (known.has(hash)) continue;
    // 已经登记的新回复可能还没落盘到 chat-history（界面在这一轮才拿到），
    // 但主进程在返回结果时就会登记，所以这里命中不了只可能是被改过。
    return (
      `第 ${i + 1} 条助手回复不在本机记录里（可能被篡改，或来自其他会话），已拒绝发送。` +
      "如果它确实是说错的，用消息下面的「更正这条」改好再发。"
    );
  }
  return null;
}

/** 主进程真正拿到模型回复后登记。空回复不登记（重试时不该被当成原文）。 */
export async function rememberAssistantTurn(
  paths: EnginePaths,
  sessionKey: string,
  text: string,
): Promise<void> {
  if (typeof text !== "string" || text.length === 0) return;
  const ledger = await ensureLedger(paths, sessionKey);
  const hash = hashOf(text);
  if (ledger.hashes.includes(hash)) return;
  ledger.hashes.push(hash);
  try {
    await writeLedger(paths, ledger);
  } catch {
    // 落盘失败只影响下次启动的核对精度，不打断本轮对话
  }
}

/** 用户更正一条 assistant 后，把旧原文从台账撤下、登记新原文。 */
export async function replaceAssistantHash(
  paths: EnginePaths,
  sessionKey: string,
  oldText: string,
  newText: string,
): Promise<void> {
  const ledger = await ensureLedger(paths, sessionKey);
  const oldHash = hashOf(oldText);
  const newHash = hashOf(newText);
  ledger.hashes = ledger.hashes.filter((h) => h !== oldHash);
  if (!ledger.hashes.includes(newHash)) ledger.hashes.push(newHash);
  try {
    await writeLedger(paths, ledger);
  } catch {
    // 同上
  }
}

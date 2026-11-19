/**
 * 结构化称呼档案（R3）。
 *
 * 为什么单拉出来：称呼是「被记住」里最不能错的一项（用户最大的雷点就是被忘记/被忽视），
 * 但它原先只活在 USER.md 的自由文本里——模型一次笔误就能写进长期记忆，壳完全不知情。
 * 这里把称呼变成结构化字段：
 *
 *   - `profile.json` 是唯一事实源：`name / confirmedAt / source / quote / pending`。
 *   - 只有用户点确认、且这个称呼**确实出现在用户说过的话里**（回读原话）才会生效。
 *   - 模型只能提议：每轮结束后核对 USER.md，发现称呼行与已确认值不同，就记为 `pending`，
 *     并把 USER.md 的称呼行改回已确认值（没有已确认值时先摘掉），让它无法自己定稿。
 *   - 已有 USER.md 里的称呼（如「芜柒」）在首次启动时迁移为已确认，不丢。
 *
 * 文件放在 workspace（与 USER.md 同目录、同命运）；重置记忆时一并删除。
 */
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EnginePaths } from "./paths";
import { loadChatHistory } from "./chathistory";

const PROFILE_FILE = "profile.json";
const USER_FILE = "USER.md";
const PROFILE_VERSION = 1;
const MAX_NAME_CHARS = 32;

/** 承认识别「称呼行」的两类写法：带引号的「自称/称呼」、以及「称呼…为 X」。 */
const NAME_LINE = /^-\s*[^\n]*(?:自称[^\n]*[「『"]|称呼[^\n]*(?:为|叫|作)[^\n]*)/;

export interface PendingName {
  readonly name: string;
  readonly observedAt: string;
  /** 谁写进来的。目前只有模型改写 USER.md 一种。 */
  readonly source: "model-write";
}

export interface UserProfile {
  version: number;
  name: string | null;
  confirmedAt: string | null;
  source: "user-confirmed" | "migrated-from-USER.md" | null;
  /** 用户确认时引用的原话（回读校验通过的那一句）。 */
  quote: string | null;
  pending: PendingName | null;
}

export interface ProfileView {
  readonly name: string | null;
  readonly confirmedAt: string | null;
  readonly source: UserProfile["source"];
  readonly pending: PendingName | null;
}

export type ConfirmResult =
  | { readonly ok: true; readonly profile: ProfileView }
  | { readonly ok: false; readonly error: string };

export type DismissResult = { readonly ok: true; readonly profile: ProfileView };

function profilePath(paths: EnginePaths): string {
  return join(paths.workspace, PROFILE_FILE);
}

function userPath(paths: EnginePaths): string {
  return join(paths.workspace, USER_FILE);
}

function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function emptyProfile(): UserProfile {
  return {
    version: PROFILE_VERSION,
    name: null,
    confirmedAt: null,
    source: null,
    quote: null,
    pending: null,
  };
}

function viewOf(profile: UserProfile): ProfileView {
  return {
    name: profile.name,
    confirmedAt: profile.confirmedAt,
    source: profile.source,
    pending: profile.pending,
  };
}

function normalizeProfile(input: unknown): UserProfile {
  const base = emptyProfile();
  if (!input || typeof input !== "object") return base;
  const raw = input as Partial<UserProfile>;
  if (raw.version !== PROFILE_VERSION) return base;
  if (typeof raw.name === "string" && raw.name.trim().length > 0) base.name = raw.name.trim();
  if (typeof raw.confirmedAt === "string") base.confirmedAt = raw.confirmedAt;
  if (raw.source === "user-confirmed" || raw.source === "migrated-from-USER.md") base.source = raw.source;
  if (typeof raw.quote === "string") base.quote = raw.quote;
  const pending = raw.pending as Partial<PendingName> | null | undefined;
  if (pending && typeof pending.name === "string" && pending.name.trim().length > 0) {
    base.pending = {
      name: pending.name.trim(),
      observedAt: typeof pending.observedAt === "string" ? pending.observedAt : today(),
      source: "model-write",
    };
  }
  return base;
}

async function saveProfile(paths: EnginePaths, profile: UserProfile): Promise<void> {
  await mkdir(paths.workspace, { recursive: true });
  const file = profilePath(paths);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
}

async function readProfileFile(paths: EnginePaths): Promise<UserProfile | null> {
  try {
    const raw = await readFile(profilePath(paths), "utf8");
    return normalizeProfile(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function readUserFile(paths: EnginePaths): Promise<string | null> {
  try {
    return await readFile(userPath(paths), "utf8");
  } catch {
    return null;
  }
}

async function writeUserFile(paths: EnginePaths, text: string): Promise<void> {
  const file = userPath(paths);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, file);
}

/** 从 USER.md 里读出称呼。读不到返回 null（不猜）。 */
export function parseNameFromUserFile(text: string): string | null {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!NAME_LINE.test(line)) continue;
    const quoted = line.match(/[「『"]([^」』"\n]+)[」』"]/);
    if (quoted?.[1]?.trim()) return quoted[1].trim();
    const plain = line.match(/称呼[^\n]*?(?:为|叫|作)\s*([^。\n，,；;]+)/);
    if (plain?.[1]?.trim()) return plain[1].trim();
  }
  return null;
}

function canonicalLine(name: string): string {
  // 用户是无性别的（D033）：这里只能用中性表述。
  return `- 用户自称「${name}」，希望被这样称呼。`;
}

function hasCanonicalLine(text: string, name: string): boolean {
  const canonical = canonicalLine(name);
  return text.split(/\r?\n/).some((line) => line.trim() === canonical);
}

/**
 * 重写 USER.md 的称呼行：有 name 就保留一条规范写法；没有 name 就整行摘掉。
 * 只动称呼行，其他条目一个字不碰。
 */
export function rewriteNameLine(text: string, name: string | null): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let placed = false;
  for (const line of lines) {
    if (NAME_LINE.test(line)) {
      if (name && !placed) {
        out.push(canonicalLine(name));
        placed = true;
      }
      continue;
    }
    out.push(line);
  }
  if (name && !placed) {
    const block = [`<!-- observed: ${today()} | status: active -->`, "", canonicalLine(name), ""];
    const related = out.findIndex((line) => line.trim() === "## Related");
    if (related >= 0) out.splice(related, 0, ...block);
    else out.push("", ...block);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * 启动时的迁移：没有 profile.json 就从 USER.md 接上已经存在的称呼。
 * 这是「旧档案平滑延续」的唯一入口——只在文件缺失时发生一次，之后一律以 profile.json 为准。
 */
export async function ensureProfile(paths: EnginePaths): Promise<UserProfile> {
  const existing = await readProfileFile(paths);
  if (existing) return existing;

  const userText = await readUserFile(paths);
  const name = userText ? parseNameFromUserFile(userText) : null;
  const profile = emptyProfile();
  if (name) {
    profile.name = name;
    profile.source = "migrated-from-USER.md";
    // 旧档案不知道确认日期，用 USER.md 的修改日期兜底，避免编一个日期。
    profile.confirmedAt = await fileDate(paths);
    profile.quote = userText
      ?.split(/\r?\n/)
      .find((line) => NAME_LINE.test(line) && line.includes(name)) ?? null;
  }
  try {
    await saveProfile(paths, profile);
  } catch {
    // 写不进去也只影响下次启动，本次仍按内存结果走
  }
  return profile;
}

async function fileDate(paths: EnginePaths): Promise<string> {
  try {
    const info = await stat(userPath(paths));
    const d = info.mtime;
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  } catch {
    return today();
  }
}

/**
 * 每轮对话后核对：模型若改了 USER.md 的称呼，不算数。
 *   - 已有确认值：记 pending，并把行改回确认值；
 *   - 没有确认值：记 pending，并把行摘掉（否则下一会话就被注入成事实）。
 * 返回核对后的档案，供界面立刻显示确认条。
 */
export async function reconcileProfile(paths: EnginePaths): Promise<UserProfile> {
  const profile = await ensureProfile(paths);
  const text = await readUserFile(paths);
  if (text === null) return profile;

  const inFile = parseNameFromUserFile(text);
  if (profile.name) {
    // 名字一致但写法仍是旧的中性化前文案时也要重写一次，
    // 这样升级后不需要用户手动改档案。
    const stale = inFile !== profile.name || !hasCanonicalLine(text, profile.name);
    if (stale) {
      if (inFile && inFile !== profile.name) {
        profile.pending = { name: inFile, observedAt: today(), source: "model-write" };
      }
      const next = rewriteNameLine(text, profile.name);
      if (next !== text) {
        try {
          await writeUserFile(paths, next);
        } catch {
          // 改不回去也不能丢档案：下次启动再核
        }
      }
      try {
        await saveProfile(paths, profile);
      } catch {
        // 同上
      }
    }
    return profile;
  }

  if (inFile) {
    profile.pending = { name: inFile, observedAt: today(), source: "model-write" };
    const next = rewriteNameLine(text, null);
    if (next !== text) {
      try {
        await writeUserFile(paths, next);
      } catch {
        // 同上
      }
    }
    try {
      await saveProfile(paths, profile);
    } catch {
      // 同上
    }
  }
  return profile;
}

export async function getProfileView(paths: EnginePaths): Promise<ProfileView> {
  const profile = await ensureProfile(paths);
  return viewOf(profile);
}

function validName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (name.length === 0 || name.length > MAX_NAME_CHARS) return null;
  if (/[\n\r\t]/.test(name)) return null;
  if (/[「」『』"]/.test(name)) return null;
  return name;
}

/**
 * 用户确认称呼。两道条件缺一不可：
 *   1. 是用户主动点的确认（调用这个 IPC 本身就是确认动作）；
 *   2. 回读对话历史，这个名字**确实出现在用户说过的话里**——防止把模型的提议当事实。
 */
export async function confirmUserName(
  paths: EnginePaths,
  sessionKey: string,
  rawName: unknown,
): Promise<ConfirmResult> {
  const name = validName(rawName);
  if (!name) {
    return { ok: false, error: "称呼不能为空、不能换行或带引号，最长 32 个字。" };
  }
  const history = await loadChatHistory(paths, sessionKey);
  const quote = history
    .filter((turn) => turn.role === "user" && turn.content.includes(name))
    .map((turn) => turn.content)
    .pop();
  if (!quote) {
    return {
      ok: false,
      error: `你在对话里没说过「${name}」这个称呼。先在对话里明确告诉它你想被怎么称呼，再点确认。`,
    };
  }

  const profile = await ensureProfile(paths);
  profile.name = name;
  profile.confirmedAt = today();
  profile.source = "user-confirmed";
  profile.quote = quote;
  profile.pending = null;
  await saveProfile(paths, profile);

  const text = await readUserFile(paths);
  if (text !== null) {
    try {
      await writeUserFile(paths, rewriteNameLine(text, name));
    } catch {
      // 档案已确认；USER.md 写失败下次核对会补上
    }
  }
  return { ok: true, profile: viewOf(profile) };
}

/** 用户否掉模型的提议。只清 pending，不动已确认值。 */
export async function dismissPendingName(paths: EnginePaths): Promise<DismissResult> {
  const profile = await ensureProfile(paths);
  profile.pending = null;
  try {
    await saveProfile(paths, profile);
  } catch {
    // 清不掉也只是下次再问一遍
  }
  return { ok: true, profile: viewOf(profile) };
}

/**
 * 馄饨自己的 BOOTSTRAP 仪式（D030）。
 *
 * 为什么不用引擎原生的 BOOTSTRAP.md：
 *   引擎把 workspace 的 setup_completed_at 写死之后，仪式就永久退役了；
 *   就算再放一个 BOOTSTRAP.md，next turn 也会因为 workspace 已 configured
 *   （人格文件改过 + memory/ 存在）被 reconcile 成完成态并删掉文件。
 *   我们这个 workspace 早就 configured，原生机制不会再跑。
 *
 * 所以照 HundunAgent 的路子，由壳自己持有状态：
 *   - 文件在 = 仪式没过；发消息时把文件内容注入到用户消息前面；
 *   - 模型判断聊完了，在回复末尾写 [[BOOTSTRAP_DONE]]；
 *   - 壳检测标记、删掉文件、把标记从界面文本里剥掉；
 *   - 文件没了 = 仪式过了，以后都是正常聊天。
 *
 * 标记走流式过滤，用户不会看到那一串方括号一闪而过。
 */
import { readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { ChatTurn } from "./chat";
import type { EnginePaths } from "./paths";

export const BOOTSTRAP_FILE = "BOOTSTRAP.md";

/** 完成标记。模型写在回复最后一行；壳看到就删仪式文件。 */
const DONE_MARKER = "[[BOOTSTRAP_DONE]]";
const DONE_RE = /\[\[\s*BOOTSTRAP_DONE\s*\]\]/i;

/** 写进 workspace 的仪式正文。人能读懂，模型也能照着做。 */
export const BOOTSTRAP_TEMPLATE = `# BOOTSTRAP.md — 第一次好好认识

这不是关卡。用户带着事来，先把事办了；事办完了，或者有安静的空当，再把这段聊完。

你已经知道自己的名字叫馄饨，也知道用户是谁。这一轮要做的不是问「你叫什么」，而是把日子里的他认识清楚——他最近在过什么样的生活，什么让他难受，什么不能碰。

## 怎么聊

- 一次只问一个问题。问完就停，认真听他回答，接着他的话往下聊，再问下一个。
- 不要变成问卷。不要一口气列五条，不要说「请回答以下问题」。
- 他说得多，你就多听。愿意展开就跟着展开；不想说就跳过去，不要追。
- 你自己也说点真的。不是只提问的机器——被问到时，说说你怎么想。
- 如果可以，把聊到的东西写进 USER.md，用 \`<!-- observed: YYYY-MM-DD | status: active -->\` 标好。

## 想弄清楚的几件事

1. 怎么称呼他。不是名字也行，一个他听着舒服的叫法。
2. 他最近在过什么日子。工作、作息、身边有哪些人，挑他愿意说的。
3. 什么事会让他难受。不是要挖伤口，是以后别踩。
4. 红线。哪些事绝不能替他做、绝不能拿去开玩笑。

## 什么时候算完了

上面几件事聊得差不多了，或者他明确说「不用了 / 别问了」，就在回复最后单独一行写：

${DONE_MARKER}

写完这一行，仪式就结束。别提前写，也别在正事回复里写。

如果聊了两三轮他都没有继续的意思，也写这一行——仪式不该变成负担。
`;

function bootstrapPath(paths: EnginePaths): string {
  const workspace = resolve(paths.workspace);
  // 路径白名单：只允许 workspace/BOOTSTRAP.md，别的地方不碰。
  if (basename(workspace) !== "workspace") {
    throw new Error(`仪式文件目标不对，拒绝操作：${workspace}`);
  }
  return join(workspace, BOOTSTRAP_FILE);
}

/** 仪式是否还没过。文件在且非空就算 pending。 */
export async function isBootstrapPending(paths: EnginePaths): Promise<boolean> {
  const raw = await readFile(bootstrapPath(paths), "utf8").catch(() => "");
  return raw.trim().length > 0;
}

/**
 * 重置记忆后重新种下仪式。已经 pending 就不动。
 * 返回是否真的写了文件。
 */
export async function ensureBootstrap(paths: EnginePaths): Promise<boolean> {
  if (await isBootstrapPending(paths)) return false;
  await writeFile(bootstrapPath(paths), BOOTSTRAP_TEMPLATE, { encoding: "utf8", mode: 0o600 });
  return true;
}

/**
 * 把仪式正文注入到最后一条用户消息前面。
 * 注入的是副本，渲染层看到的对话历史不变——用户不会看到这段内部指令。
 */
export async function applyBootstrap(
  paths: EnginePaths,
  messages: readonly ChatTurn[],
): Promise<{ messages: ChatTurn[]; pending: boolean }> {
  const out = [...messages];
  if (!(await isBootstrapPending(paths))) return { messages: out, pending: false };

  const body = (await readFile(bootstrapPath(paths), "utf8")).trim();
  const instruction = [
    "【仪式进行中 · 这是给你的指令，不要念给用户听】",
    "下面这份文件还没走完。按它来，但用户的请求永远优先——带着正事先办完，再把仪式自然带出来。",
    "",
    body,
  ].join("\n");

  for (let i = out.length - 1; i >= 0; i -= 1) {
    const turn = out[i];
    if (turn?.role === "user") {
      out[i] = {
        role: "user",
        content: `${instruction}\n\n---\n\n用户说：${turn.content}`,
      };
      break;
    }
  }
  return { messages: out, pending: true };
}

/** 回复里有没有写完成标记。 */
export function hasDoneMarker(text: string): boolean {
  return DONE_RE.test(text);
}

/** 把完成标记从最终文本里剥掉。 */
export function stripDoneMarker(text: string): string {
  return text.replace(DONE_RE, "").trimEnd();
}

/** 仪式结束：删掉 BOOTSTRAP.md。文件不存在也算成功（幂等）。 */
export async function removeBootstrap(paths: EnginePaths): Promise<void> {
  await rm(bootstrapPath(paths), { force: true });
}

/**
 * 流式过滤完成标记。
 *
 * 标记可能跨 chunk 到达，所以每次保留尾部「可能是标记前缀」的一段不吐出去，
 * 等下一块来了再判断。确认没匹配上时把缓冲原样吐回去，不吞字。
 */
export function createDoneFilter(
  onDelta: (text: string) => void,
  enabled: boolean,
): { push: (delta: string) => void; finish: () => boolean } {
  if (!enabled) return { push: onDelta, finish: () => false };

  let buffered = "";
  let matched = false;

  return {
    push(delta: string) {
      if (matched || !delta) return;
      const text = buffered + delta;
      buffered = "";

      const at = text.indexOf(DONE_MARKER);
      if (at >= 0) {
        if (at > 0) onDelta(text.slice(0, at));
        matched = true;
        return;
      }

      // 找最长的、等于标记开头的后缀，留到下一块再判。
      let keep = 0;
      for (let n = 1; n < DONE_MARKER.length; n += 1) {
        if (text.endsWith(DONE_MARKER.slice(0, n))) keep = n;
      }
      if (keep > 0) {
        buffered = text.slice(text.length - keep);
        if (text.length > keep) onDelta(text.slice(0, text.length - keep));
      } else {
        onDelta(text);
      }
    },
    finish() {
      if (matched) return true;
      if (buffered) {
        onDelta(buffered);
        buffered = "";
      }
      return false;
    },
  };
}

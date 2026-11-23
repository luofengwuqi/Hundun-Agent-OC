/**
 * 和引擎说话：`POST /v1/chat/completions`（OpenAI 兼容，流式）。
 *
 * 三条实测事实（2026-11-17，在本机 2026.11.3 上验证，不是照文档抄的）：
 *   1. **这个端点默认是关的**。必须 `gateway.http.endpoints.chatCompletions.enabled = true`，
 *      否则连 `/v1/models` 都是 404（它属于同一组开关）。
 *   2. **会话身份靠 `x-openclaw-session-key` 头**。不带它，每个请求都是一个全新会话——
 *      也就是每次说话它都不记得你。这个头是「被记住」这件事唯一的开关，不能用随机值。
 *   3. 流是标准 OpenAI chunk：`choices[0].delta.content`，结束时那一块带 `finish_reason`，
 *      不保证有 `[DONE]`；所以判定结束要「看 finish_reason」或「看流关闭」，两者都要认。
 */
export interface ChatTurn {
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
}

export interface ChatOptions {
  readonly port: number;
  readonly token: string;
  /** 决定「它记不记得你」。同一个 key = 同一段记忆。 */
  readonly sessionKey: string;
  readonly messages: readonly ChatTurn[];
  readonly signal?: AbortSignal;
  readonly onDelta: (text: string) => void;
}

export class ChatError extends Error {
  constructor(
    message: string,
    readonly kind: "auth" | "endpoint" | "engine" | "network" | "overload",
  ) {
    super(message);
  }
}

function classify(status: number, message: string): ChatError {
  // 引擎也会用 200 的流里塞 error，这时 status 拿不到真实语义，只能看文字。
  // 实测典型句：「Inline API key for provider "deepseek" is temporarily disabled
  // after a provider auth/billing failure.」——这是钥匙不对，不是引擎坏了，
  // 归类错了会让用户去重启引擎，而正确动作是换 key。
  if (status === 401 || status === 403 || /authentication|api key|credential|billing|unauthorized/i.test(message)) {
    return new ChatError(message, "auth");
  }
  if (status === 404) return new ChatError(message, "endpoint");
  // 502/503/529 或文案带 overload：上游服务商（或它前面的 Cloudflare）过载。
  // 2026-11-18 实测：中继 cn.sidrune.ai 的模型后端整个挂了，Cloudflare 报
  // origin_bad_gateway，引擎统一翻成 "upstream provider overloaded" 甩给界面——
  // 用户看不懂这句话，会怀疑是自己配置错了。明确说清「不是你的问题、重试即可」。
  if (status === 502 || status === 503 || status === 529 || /overload/i.test(message)) {
    return new ChatError(
      `上游服务商过载了（${status}）。不是你这边的问题，等半分钟再发一次。`,
      "overload",
    );
  }
  return new ChatError(message, "engine");
}

export async function streamChat(options: ChatOptions): Promise<string> {
  const url = `http://127.0.0.1:${options.port}/v1/chat/completions`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.token}`,
        "Content-Type": "application/json",
        "x-openclaw-session-key": options.sessionKey,
      },
      body: JSON.stringify({
        // 必须是 `openclaw` 或 `openclaw/<agentId>`，别的写法引擎直接拒：
        //   `Invalid `model`. Use `openclaw` or `openclaw/<agentId>`.`
        // 用 `openclaw/default` 在「只有一个 agent」时能过，但 2026-11-22 加了 qq-gate
        // 之后变成多 agent，实测就报 `Multiple agents are configured, but this
        // operation has no explicit owner`——桌面端聊天当场全废。指到 main 才稳。
        model: "openclaw/main",
        messages: options.messages,
        stream: true,
      }),
      // 用 `?? null` 而不是直接传 undefined：项目的 exactOptionalPropertyTypes
      // 不接受 `AbortSignal | undefined` 赋给 `AbortSignal | null`。
      signal: options.signal ?? null,
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    throw new ChatError(
      `连不上引擎（127.0.0.1:${options.port}）。它可能刚退出。`,
      "network",
    );
  }

  if (!response.ok || !response.body) {
    // 引擎的错误体是 OpenAI 形状：{"error":{"message":"...","type":"..."}}
    let message = `HTTP ${response.status}`;
    try {
      const text = await response.text();
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      if (parsed.error?.message) message = parsed.error.message;
      else if (text.trim().length > 0) message = text.slice(0, 300);
    } catch {
      // 保持 HTTP 状态码当消息
    }
    throw classify(response.status, message);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let answer = "";

  try {
    for (;;) {
      // 类型用推导而不是具名的 ReadableStreamReadResult：主进程 tsconfig 不开 DOM lib，
      // 那个类型名拿不到。
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (error) {
        // 流中途被掐（undici 的 "TypeError: terminated"、ECONNRESET 都落在这里）：
        // 常见于引擎重启撞上在途回复、中继/网络抖动。不是「回复被截断」，
        // 是连接断了。翻译成人话——原样甩 "TypeError: terminated" 只会让人
        // 以为软件坏了或回复被限了字数（2026-11-17 用户真问过这个问题）。
        const raw = (error as Error).message || String(error);
        throw new ChatError(
          `回复流被中断了（${raw}）。再说一次试试；总是这样就是网络或服务不稳。`,
          "network",
        );
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });

      // SSE 以空行分隔事件。最后一段可能不完整，留在 buffer 里等下一块。
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of event.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload.length === 0 || payload === "[DONE]") continue;
          try {
            const frame = JSON.parse(payload) as {
              choices?: { delta?: { content?: string }; finish_reason?: string | null }[];
              error?: { message?: string; code?: string | number };
            };
            if (frame.error?.message) {
              // 实测（2026-11-18）：引擎对外总是 HTTP 200，上游故障塞在流里——
              // data: {"error":{"message":"upstream provider overloaded","code":"502"}}。
              // 所以真实状态码在 error.code 里，不是 response.status，别丢。
              const code = Number(frame.error.code);
              throw classify(Number.isFinite(code) && code > 0 ? code : 500, frame.error.message);
            }
            const delta = frame.choices?.[0]?.delta?.content;
            if (typeof delta === "string" && delta.length > 0) {
              answer += delta;
              options.onDelta(delta);
            }
          } catch (error) {
            if (error instanceof ChatError) throw error;
            // 单块解析失败不该炸掉整段对话：跳过它，继续读后面的
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }

  return answer;
}

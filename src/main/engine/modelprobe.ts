/**
 * 模型列表探测（D028 追加）。
 *
 * claude 式配置只有「连哪、拿什么钥匙」，没有模型列表——列表在服务端。
 * 这里去该地址 GET /v1/models 拉真实列表（Anthropic 和 OpenAI 两种方言
 * 都是 {data:[{id}]} 形状，一个解析器通吃）。
 *
 * 鉴权两个头都发：Anthropic 认 x-api-key，OpenAI 兼容端点认 Bearer，
 * 发两个不冲突（对方只认自己那个）。
 *
 * 基址规则与引擎一致（见引擎 anthropic-transport-stream.ts）：
 * 以 /v1 结尾 → + /models；否则 → + /v1/models。
 */

export interface ProbeResult {
  ok: boolean;
  models: Array<{ id: string; name: string }>;
  error?: string;
}

/** 归一化基址：去尾斜杠；/v1 结尾时探 /models，否则探 /v1/models。 */
export function modelsUrl(baseUrl: string): string | null {
  const b = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(b)) return null;
  return b.endsWith("/v1") ? `${b}/models` : `${b}/v1/models`;
}

export async function probeModels(baseUrl: string, apiKey: string, timeoutMs = 8000): Promise<ProbeResult> {
  const url = modelsUrl(baseUrl);
  if (!url) return { ok: false, models: [], error: `地址不对，探不了：${baseUrl || "(空)"}` };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    if (apiKey) {
      headers["x-api-key"] = apiKey;
      headers.authorization = `Bearer ${apiKey}`;
    }
    const res = await fetch(url, { headers, signal: ac.signal });
    if (!res.ok) {
      return { ok: false, models: [], error: `该地址不返回模型列表（HTTP ${res.status}），手写 models 吧` };
    }
    const body = (await res.json()) as { data?: unknown; models?: unknown };
    const list = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : [];
    const models: Array<{ id: string; name: string }> = [];
    for (const raw of list) {
      const m = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const id = typeof m.id === "string" ? m.id : typeof m.name === "string" ? m.name : "";
      if (id) models.push({ id, name: typeof m.name === "string" && m.name ? m.name : id });
    }
    if (!models.length) return { ok: false, models: [], error: "拉到了响应但一个模型都没认出来" };
    return { ok: true, models };
  } catch (e) {
    const msg = (e as Error).name === "AbortError" ? `超时（${timeoutMs}ms）` : (e as Error).message;
    return { ok: false, models: [], error: `探测失败：${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

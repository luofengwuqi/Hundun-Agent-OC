/**
 * claude 式配置（claude-code-settings）的识别与转换（D028 追加）。
 *
 * 用户手上的配置不止 opencode 一种形态。Claude Code 的 settings.json 长这样：
 *
 *   { "$schema": ".../claude-code-settings.json",
 *     "env": { "ANTHROPIC_BASE_URL": "https://...", "ANTHROPIC_AUTH_TOKEN": "sk-..." } }
 *
 * 它不列模型、不写 provider 段，只有「连哪、拿什么钥匙」。这份文件把它转成
 * opencode 式中间 JSON（modelconfig.ts 认识的形状），后面全走既有链路：
 * 解析 → 卡片链 → 翻译成引擎 models.providers。
 *
 * 转换约定：
 *   provider 固定叫 "anthropic"（方言是 Anthropic Messages，与引擎 api 值对应）；
 *   api 写 "anthropic-messages"——引擎拼 URL 时自己补 /v1/messages
 *   （见引擎 anthropic-transport-stream.ts 的 resolveAnthropicMessagesUrl）；
 *   baseUrl 原样（去尾斜杠），apiKey 原样明文——由 applyModelConfig 的
 *   「明文 → secrets.json」路径接手，不在这层碰磁盘；
 *   模型列表这份配置里没有：有 "model" 字段就用它，没有给一个占位 + 警告，
 *   真实列表靠 model:probe 去该地址拉（GET /v1/models）。
 *
 * 纯函数，不碰磁盘、不发请求。
 */

export interface ClaudeConvertResult {
  config: Record<string, unknown>;
  warnings: string[];
}

const ANTHROPIC_KEYS = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** 拿到 env 段里的值：先看 env 块，再看顶层（有人会拍平了写）。 */
function lookupEnv(raw: Record<string, unknown>, key: string): string {
  const env = asRecord(raw.env);
  const fromEnv = env ? env[key] : undefined;
  const v = typeof fromEnv === "string" ? fromEnv : typeof raw[key] === "string" ? (raw[key] as string) : "";
  return v.trim();
}

/**
 * 是不是 claude 式配置。判据（任一即可，但有 provider 段时让 opencode 优先）：
 *   1. $schema 指向 claude-code-settings；
 *   2. 带 ANTHROPIC_* 三件套里任何一件。
 */
export function isClaudeSettings(raw: unknown): boolean {
  const o = asRecord(raw);
  if (!o) return false;
  if (asRecord(o.provider)) return false; // opencode 式优先
  const schema = typeof o.$schema === "string" ? o.$schema : "";
  if (schema.includes("claude-code-settings")) return true;
  return ANTHROPIC_KEYS.some((k) => lookupEnv(o, k).length > 0);
}

/** claude 式 → opencode 式中间 JSON。 */
export function claudeToOpencode(raw: unknown): ClaudeConvertResult {
  const warnings: string[] = [];
  const o = asRecord(raw);
  if (!o) return { config: {}, warnings: ["这份配置不是一个对象"] };

  const baseUrl = lookupEnv(o, "ANTHROPIC_BASE_URL").replace(/\/+$/, "");
  const key = lookupEnv(o, "ANTHROPIC_AUTH_TOKEN") || lookupEnv(o, "ANTHROPIC_API_KEY");
  const modelHint = (typeof o.model === "string" ? o.model : "").trim() || lookupEnv(o, "ANTHROPIC_MODEL");

  if (!baseUrl) warnings.push("没找到 ANTHROPIC_BASE_URL，这份配置连不上任何服务");
  if (!key) warnings.push("没找到 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY，先当无密钥处理");

  // 模型列表这份配置天然没有。有 model 字段就信它；没有给占位并说明来路。
  const modelIds = modelHint ? [modelHint] : ["claude-sonnet-4-5"];
  if (!modelHint) {
    warnings.push("这份配置没写模型名，先按 claude-sonnet-4-5 占位——用「拉取模型列表」换成该地址真实的模型");
  }

  let name = "anthropic";
  try {
    name = new URL(baseUrl).host || name;
  } catch {
    /* baseUrl 不合法时让 normalize 报错，名字退回默认 */
  }

  const models: Record<string, unknown> = {};
  const order: string[] = [];
  for (const id of modelIds) {
    models[id] = { name: id };
    order.push(`anthropic/${id}`);
  }

  const config: Record<string, unknown> = {
    provider: {
      anthropic: {
        name,
        api: "anthropic-messages",
        options: {
          baseURL: baseUrl,
          // 明文原样放进来：applyModelConfig 会把它收进 secrets.json，
          // 引擎配置里只留 ${OPENCLAW_ANTHROPIC_API_KEY} 插值。
          ...(key ? { apiKey: key } : {}),
        },
        models,
      },
    },
    model: order[0] ?? "",
    "x-hundun": { modelOrder: order },
  };
  return { config, warnings };
}

/**
 * 统一入口：claude 式转成 opencode 式；本来就是 opencode 式（或别的形状）
 * 原样返回，让 normalize 自己报错。preview 和 apply 共用这一个判据，
 * 避免「预览认出来了、应用没认出来」这种两层不一致。
 */
export function ensureOpencode(raw: unknown): { config: unknown; warnings: string[]; format: "claude" | "opencode" } {
  if (isClaudeSettings(raw)) {
    const r = claudeToOpencode(raw);
    return { config: r.config, warnings: r.warnings, format: "claude" };
  }
  return { config: raw, warnings: [], format: "opencode" };
}

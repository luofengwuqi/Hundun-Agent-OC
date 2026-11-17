/**
 * 生成 / 补齐引擎配置。
 *
 * 三条纪律：
 *   1. **不覆盖用户的东西。** 已有配置只补缺失键，覆盖前先备份。
 *   2. **只写验证过的键。** 写错一个不存在的键，会让上游判定配置无效并以 78 退出，
 *      而 78 是「别重试」——结果就是装完打不开。宁可少写。
 *   3. **exec 白名单不在这里。** `tools.exec.mode` 在 openclaw.json 里，
 *      但真正的 allowlist 条目存在 approvals 文档（共享 SQLite 状态）里，
 *      要经 `openclaw approvals` 写入。把 allowlist 数组写进本文件**不会生效**，
 *      这是一个看起来对、实际什么都不管的坑。
 */
import { randomBytes } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface SeedOptions {
  /** 网关鉴权 token；不给就现生成 48 位十六进制。 */
  readonly token?: string;
  /** 模型 ref，如 `deepseek/deepseek-v4-flash`。留空则不写模型键，交由用户导入配置（D008）。 */
  readonly model?: string;
}

/** 一个自定义 provider 的完整描述。字段全部有出处，见 `ensureModelProvider` 的注释。 */
export interface ModelProviderSpec {
  /** provider id，会成为模型 ref 的前缀，例如 `deepseek`。 */
  readonly provider: string;
  /** OpenAI 兼容的 base URL，必须带 `/v1`。 */
  readonly baseUrl: string;
  /** 协议形态。实测本机只认 `openai-completions` 这一档能走通。 */
  readonly api: string;
  /** 模型 id，例如 `deepseek-v4-flash`。 */
  readonly modelId: string;
  /** 界面上显示的名字。 */
  readonly modelName: string;
  /** 密钥来自哪个环境变量，例如 `DEEPSEEK_API_KEY`。配置里只写 `${ENV}`，不写明文。 */
  readonly apiKeyEnv: string;
}

export interface SeedResult {
  readonly configPath: string;
  readonly created: boolean;
  readonly backedUpTo?: string;
  /** 需要让用户知道的事，例如「旧配置不是合法 JSON」。 */
  readonly warnings: readonly string[];
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function generateToken(): string {
  return randomBytes(24).toString("hex"); // 48 位，与上游生成习惯一致
}

/**
 * 只补不覆盖：seed 里的键在 existing 里不存在时才写入。
 * 数组与标量一律「有就不动」——我们没资格判断用户的数组该不该合并。
 */
export function mergeMissing(existing: Json, seed: Json): Json {
  const out: Json = { ...existing };
  for (const [key, seedValue] of Object.entries(seed)) {
    const current = out[key];
    if (current === undefined) {
      out[key] = seedValue;
      continue;
    }
    if (isObject(current) && isObject(seedValue)) {
      out[key] = mergeMissing(current, seedValue);
    }
  }
  return out;
}

export function buildSeed(options: SeedOptions = {}): Json {
  const seed: Json = {
    gateway: {
      mode: "local",
      auth: { mode: "token", token: options.token ?? generateToken() },
      http: {
        endpoints: {
          /**
           * `POST /v1/chat/completions` **默认是关的**（schema 原话：
           * "Enable the OpenAI-compatible POST /v1/chat/completions endpoint (default: false)"）。
           * 实测：不开这个键，连 `/v1/models` 都返回 404——它属于同一组开关。
           * 我们的界面全部对话都走这个端点，所以必须开。
           */
          chatCompletions: { enabled: true },
        },
      },
    },
    tools: {
      exec: {
        // D021：只跑预置指令。注意此处**故意不写 allowlist**——
        // 空白名单 + allowlist 模式 = 一条命令都不放行，这是安全的默认值。
        // 真正要放行的动作，等我们写好预置指令后再经 approvals 加。
        mode: "allowlist",
      },
    },
  };
  if (options.model && options.model.trim().length > 0) {
    seed.agents = { defaults: { model: { primary: options.model.trim() } } };
  }
  return seed;
}

async function readJsonIfPresent(path: string): Promise<{ json?: Json; raw?: string }> {
  try {
    const raw = await readFile(path, "utf8");
    if (raw.trim().length === 0) return { raw };
    return { json: JSON.parse(raw) as Json, raw };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    if (error instanceof SyntaxError) return { raw: await readFile(path, "utf8").catch(() => "") };
    throw error;
  }
}

/** 确保配置文件存在且含必要键。幂等：第二次调用不会改任何东西。 */
export async function ensureConfigFile(
  configPath: string,
  options: SeedOptions = {},
): Promise<SeedResult> {
  const warnings: string[] = [];
  await mkdir(dirname(configPath), { recursive: true });

  const { json, raw } = await readJsonIfPresent(configPath);

  if (!json) {
    const seed = buildSeed(options);
    const hadBroken = typeof raw === "string" && raw.trim().length > 0;
    let backedUpTo: string | undefined;
    if (hadBroken) {
      backedUpTo = `${configPath}.broken-${Date.now()}`;
      await copyFile(configPath, backedUpTo);
      warnings.push(
        `原配置不是合法 JSON，已备份到 ${backedUpTo}，并按默认配置重建。原内容没有被删除。`,
      );
    }
    await writeFile(configPath, `${JSON.stringify(seed, null, 2)}\n`, { mode: 0o600 });
    await chmod(configPath, 0o600);
    return backedUpTo
      ? { configPath, created: true, backedUpTo, warnings }
      : { configPath, created: true, warnings };
  }

  const merged = mergeMissing(json, buildSeed(options));
  if (JSON.stringify(merged) === JSON.stringify(json)) {
    return { configPath, created: false, warnings };
  }

  const backup = `${configPath}.bak-${Date.now()}`;
  await copyFile(configPath, backup);
  await writeFile(configPath, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  await chmod(configPath, 0o600);
  warnings.push(`补齐了缺失的配置键，原文件备份到 ${backup}`);
  return { configPath, created: false, backedUpTo: backup, warnings };
}

/** 读回 token，供壳发起 HTTP 请求时用。 */
export async function readGatewayToken(configPath: string): Promise<string | undefined> {
  const { json } = await readJsonIfPresent(configPath);
  const gateway = json?.gateway;
  if (!isObject(gateway)) return undefined;
  const auth = gateway.auth;
  if (!isObject(auth)) return undefined;
  const token = auth.token;
  return typeof token === "string" && token.length > 0 ? token : undefined;
}

/**
 * 写入自定义 provider + 默认模型。
 *
 * 这几个键都经过实测（2026-11-17，引擎 2026.11.3），不是照文档抄的：
 *   `agents.defaults.model.primary` —— 不写它，请求会退回内置 openai 路由，报
 *        "No route-compatible authentication source is configured for openai."
 *   `models.providers.<id>.baseUrl` —— 必须带 `/v1`
 *   `models.providers.<id>.apiKey`  —— 写 `${ENV}` 插值，**不写明文**：
 *        明文会躺在用户随时会打开、也随时会截图发出去的配置里
 *   `models.providers.<id>.api`     —— `openai-completions`
 *
 * 判据：写完引擎仍能正常启动（配置被接受、没有触发 78 退出），并且错误从
 * 「没有鉴权源」变成「provider 鉴权失败」——那说明模型路由真的接上了。
 */
export async function ensureModelProvider(
  configPath: string,
  spec: ModelProviderSpec,
): Promise<{ changed: boolean; modelRef: string }> {
  const modelRef = `${spec.provider}/${spec.modelId}`;
  const { json } = await readJsonIfPresent(configPath);
  if (!json) throw new Error("配置文件不存在，先确保 ensureConfigFile 跑过");

  const next: Json = { ...json };

  const agents = isObject(next.agents) ? { ...next.agents } : {};
  const defaults = isObject(agents.defaults) ? { ...agents.defaults } : {};
  const model = isObject(defaults.model) ? { ...defaults.model } : {};
  model.primary = modelRef;
  defaults.model = model;
  agents.defaults = defaults;
  next.agents = agents;

  const models = isObject(next.models) ? { ...next.models } : {};
  // merge：保留用户自己定义的其他 provider，不做整体替换
  models.mode = models.mode ?? "merge";
  const providers = isObject(models.providers) ? { ...models.providers } : {};
  providers[spec.provider] = {
    baseUrl: spec.baseUrl,
    apiKey: `\${${spec.apiKeyEnv}}`,
    api: spec.api,
    models: [{ id: spec.modelId, name: spec.modelName }],
  };
  models.providers = providers;
  next.models = models;

  if (JSON.stringify(next) === JSON.stringify(json)) return { changed: false, modelRef };

  const backup = `${configPath}.bak-${Date.now()}`;
  await copyFile(configPath, backup);
  await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await chmod(configPath, 0o600);
  return { changed: true, modelRef };
}

/** 当前配置里的默认模型 ref。界面用它判断「配没配模型」。 */
export async function readModelRef(configPath: string): Promise<string | undefined> {
  const { json } = await readJsonIfPresent(configPath);
  const agents = json?.agents;
  if (!isObject(agents)) return undefined;
  const defaults = agents.defaults;
  if (!isObject(defaults)) return undefined;
  const model = defaults.model;
  if (!isObject(model)) return undefined;
  const primary = model.primary;
  return typeof primary === "string" && primary.length > 0 ? primary : undefined;
}

/**
 * 读回引擎配置里已保存的 provider 集，反推成 opencode 式的预览形状（D028）。
 *
 * 用途：设置页重启后，编辑器是空的，但引擎里已经配好了模型——卡片链必须显示这些，
 * 否则用户会以为「配好的模型丢了」。这里把引擎格式翻译回界面认识的 provider/chain 形状。
 */
export async function readSavedProviders(configPath: string): Promise<{
  providers: Array<{ id: string; name: string; baseUrl: string; api: string; hasKey: boolean; envName: string | null; models: Array<{ id: string; name: string; context: number; output: number }> }>;
  primaryRef: string | null;
}> {
  const { json } = await readJsonIfPresent(configPath);
  const models = json?.models;
  const providers: Array<{ id: string; name: string; baseUrl: string; api: string; hasKey: boolean; envName: string | null; models: Array<{ id: string; name: string; context: number; output: number }> }> = [];
  if (isObject(models)) {
    const provNode = models.providers;
    if (isObject(provNode)) {
      for (const [id, confRaw] of Object.entries(provNode)) {
        const conf = isObject(confRaw) ? confRaw : {};
        const baseUrl = typeof conf.baseUrl === "string" ? conf.baseUrl : "";
        const modelList = Array.isArray(conf.models)
          ? (conf.models as Array<Record<string, unknown>>)
          : [];
        // apiKey 只会是 ${ENV} 插值（明文在 secrets.json）。把名字抽出来，
        // 反向加载时原样还原——否则重启后密钥引用会指错环境变量。
        const interp = typeof conf.apiKey === "string" ? conf.apiKey.trim().match(/^\$\{(.+)\}$/) : null;
        providers.push({
          id,
          name: typeof conf.name === "string" && conf.name ? conf.name : id,
          baseUrl,
          api: typeof conf.api === "string" && conf.api ? conf.api : "openai-completions",
          hasKey: typeof conf.apiKey === "string" && conf.apiKey.length > 0,
          envName: interp && interp[1] ? interp[1] : null,
          models: modelList.map((m) => {
            // 引擎模型行的元数据字段叫 contextWindow/maxTokens（不是 opencode 的
            // limit.*，也不是 context）。读错字段名的话，上下文/输出上限会在重启后
            // 悄悄丢成 0——往返一趟（apply → 重启 → 反向加载 → 再 apply）就把
            // 元数据洗没了。这里读回成 opencode 语义的 context/output。
            const ctx = Number(m.contextWindow);
            const out = Number(m.maxTokens);
            return {
              id: typeof m.id === "string" ? m.id : "",
              name: typeof m.name === "string" && m.name ? m.name : (typeof m.id === "string" ? m.id : ""),
              context: Number.isFinite(ctx) && ctx > 0 ? Math.floor(ctx) : 0,
              output: Number.isFinite(out) && out > 0 ? Math.floor(out) : 0,
            };
          }),
        });
      }
    }
  }
  return { providers, primaryRef: (await readModelRef(configPath)) ?? null };
}

/**
 * 把翻译好的多 provider + 首选模型合并进 openclaw.json（D028）。
 *
 * 与 ensureModelProvider 的区别：那个只写**一个** provider；这里把整份导入结果
 * （多个 provider + 链的首选）一次性写入。写入前先备份，幂等（内容没变就不动）。
 *
 * 引擎配置里只写 ${ENV} 插值，明文密钥不进来（在 secrets.json）。
 */
export async function writeModelProviders(
  configPath: string,
  providers: Record<string, unknown>,
  primaryRef: string | null,
): Promise<{ changed: boolean }> {
  const { json } = await readJsonIfPresent(configPath);
  if (!json) throw new Error("配置文件不存在，先确保 ensureConfigFile 跑过");

  const next: Json = { ...json };

  const models = isObject(next.models) ? { ...next.models } : {};
  models.mode = models.mode ?? "merge";
  // 导入是「整份替换」用户当前的模型 provider 集，还是「合并」？
  // 这里选替换：用户导入一份新配置，意图就是「用这份」，不是「和旧的拼一起」。
  models.providers = providers;
  next.models = models;

  if (primaryRef) {
    const agents = isObject(next.agents) ? { ...next.agents } : {};
    const defaults = isObject(agents.defaults) ? { ...agents.defaults } : {};
    const model = isObject(defaults.model) ? { ...defaults.model } : {};
    model.primary = primaryRef;
    defaults.model = model;
    agents.defaults = defaults;
    next.agents = agents;
  }

  if (JSON.stringify(next) === JSON.stringify(json)) return { changed: false };

  const backup = `${configPath}.bak-${Date.now()}`;
  await copyFile(configPath, backup);
  await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await chmod(configPath, 0o600);
  return { changed: true };
}

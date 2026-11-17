/**
 * opencode 式模型配置的解析层（D028）。
 *
 * 借鉴 /home/wuqi/code/hundunAgent/src/main/models.js 的设计，但**只借鉴、不照搬**：
 * hundunAgent 自己直连模型，所以它把 opencode JSON 当唯一事实源直接用；
 * 我们这里引擎才是真正发请求的那一方，所以这份 JSON 只是「用户看到的中间层」，
 * 解析之后要**翻译成引擎的 models.providers 格式**（见 modelapply.ts）。
 *
 * 所以本文件只做三件纯事，不碰磁盘、不发请求：
 *   1. 占位符替换：{env:NAME} / {file:path}
 *   2. provider/model 引用切分（按第一个斜杠）
 *   3. normalize：一次把所有问题说全（不是修一个报一个）
 *
 * 保留的三块金子（来自 hundunAgent，理由不变）：
 *   - {env:}/{file:} 占位符：不把 key 抄进配置、不用多机同步同一份 key。
 *   - 按第一个斜杠切引用：模型 id 本身可以带斜杠（google/gemma-3n-e4b）。
 *   - 排序链纯函数：顺序错了的表现只是「用的不是排第一那个」，没有任何报错，
 *     所以排序必须和解析共用一套事实，不能各存一份。
 */

const VAR_RE = /\{(env|file):([^}]+)\}/g;

export interface ModelEntry {
  id: string;
  name: string;
  context: number;
  output: number;
}

export interface ProviderEntry {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  hasKey: boolean;
  /**
   * 引擎的 api 方言：openai-completions / anthropic-messages / ……
   * claude 式配置转出来的是 anthropic-messages，这里透传到引擎配置，
   * 缺省 openai-completions（opencode 式与本地模型的常态）。
   */
  api: string;
  models: ModelEntry[];
}

export interface ChainItem {
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  baseUrl: string;
  apiKey: string;
  contextWindow: number;
}

export interface NormalizeResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  providers: ProviderEntry[];
  /** 顶层 model 的原文，例如 "deepseek/deepseek-chat"。 */
  ref: string;
  selected: ChainItem | null;
  /** 依次尝试的整条链：第一个是首选，后面是备用。 */
  chain: ChainItem[];
}

export function splitRef(ref: string): { providerId: string; modelId: string } | null {
  const s = String(ref || "").trim();
  const i = s.indexOf("/");
  if (i <= 0 || i === s.length - 1) return null;
  return { providerId: s.slice(0, i), modelId: s.slice(i + 1) };
}

/** 替换 {env:NAME} / {file:path}。整值就是占位符时保留原类型。 */
export function substitute(
  value: unknown,
  baseDir: string,
  resolveVar: (kind: "env" | "file", name: string) => string,
  warns: string[],
  where: string,
): unknown {
  if (typeof value === "string") {
    const whole = value.trim().match(/^\{(env|file):([^}]+)\}$/);
    if (whole && whole[1] && whole[2] !== undefined) {
      return resolveVar(whole[1] as "env" | "file", whole[2].trim());
    }
    return value.replace(VAR_RE, (_m, kind: string, name: string) => {
      const got = resolveVar(kind as "env" | "file", String(name).trim());
      return got ?? "";
    });
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, baseDir, resolveVar, warns, where));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = substitute(v, baseDir, resolveVar, warns, where);
    }
    return out;
  }
  return value;
}

/**
 * 解析并校验。占位符替换在这里完成——**替换只发生在内存里**，不落盘，
 * 所以「{env:XXX} 没设」只会变成一条警告 + 空 key，而不会把空串写进配置。
 */
export function normalize(raw: unknown, opts: { baseDir?: string; resolveVar?: (kind: "env" | "file", name: string) => string } = {}): NormalizeResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const baseDir = opts.baseDir || process.cwd();
  const resolveVar = opts.resolveVar ?? ((kind, name) => {
    if (kind === "env") return process.env[name] ?? "";
    // 缺省不读文件：解析层不该有磁盘副作用。要读文件由调用方传 resolveVar。
    warnings.push(`{file:${name}} 需要调用方提供文件读取，这里按空值处理`);
    return "";
  });

  const src = substitute(raw, baseDir, resolveVar, warnings, "配置") as Record<string, unknown>;

  if (!src || typeof src !== "object" || Array.isArray(src)) {
    return { ok: false, errors: ["这份 JSON 的顶层必须是一个对象"], warnings, providers: [], ref: "", selected: null, chain: [] };
  }

  const provNode = src.provider;
  if (!provNode || typeof provNode !== "object" || Array.isArray(provNode)) {
    return {
      ok: false,
      errors: ['缺 provider 段。至少要有一个 provider，形如 "provider": { "deepseek": { ... } }'],
      warnings,
      providers: [],
      ref: "",
      selected: null,
      chain: [],
    };
  }

  const providers: ProviderEntry[] = [];
  for (const [id, confRaw] of Object.entries(provNode as Record<string, unknown>)) {
    if (id.includes("/")) {
      errors.push(`provider 的 id 不能带斜杠（${id}）：引用是 "provider/model"，带斜杠就切不开了`);
      continue;
    }
    const conf = (confRaw && typeof confRaw === "object" ? confRaw : {}) as Record<string, unknown>;
    const options = (conf.options && typeof conf.options === "object" ? conf.options : {}) as Record<string, unknown>;
    const baseUrl = String(options.baseURL || options.baseUrl || "").trim();
    if (!baseUrl) errors.push(`${id}：缺 options.baseURL，没有地址就没法发请求`);
    else if (!/^https?:\/\//i.test(baseUrl)) errors.push(`${id}：baseURL 必须以 http:// 或 https:// 开头（现在是 ${baseUrl}）`);

    const apiKey = String(options.apiKey == null ? "" : options.apiKey).trim();
    if (!apiKey) warnings.push(`${id}：没有 apiKey，本地模型没关系，云端服务商这样会 401`);

    // api 方言：claude 式转来的带 anthropic-messages；没写按 openai-completions。
    const api = String(conf.api == null ? "" : conf.api).trim() || "openai-completions";

    const modelNode = (conf.models && typeof conf.models === "object" ? conf.models : {}) as Record<string, unknown>;
    const modelKeys = Object.keys(modelNode);
    if (!modelKeys.length) {
      errors.push(`${id}：缺 models，一个模型都没有就等于这个 provider 用不了`);
      continue;
    }

    const models: ModelEntry[] = [];
    for (const mid of modelKeys) {
      const m = (modelNode[mid] && typeof modelNode[mid] === "object" ? modelNode[mid] : {}) as Record<string, unknown>;
      const limit = (m.limit && typeof m.limit === "object" ? m.limit : {}) as Record<string, unknown>;
      const context = Number(limit.context);
      models.push({
        id: mid,
        name: String(m.name || mid),
        context: Number.isFinite(context) && context > 0 ? Math.floor(context) : 0,
        output: Number(limit.output) > 0 ? Math.floor(Number(limit.output)) : 0,
      });
    }

    providers.push({ id, name: String(conf.name || id), baseUrl, apiKey, hasKey: Boolean(apiKey), api, models });
  }

  if (!providers.length && !errors.length) errors.push("provider 段里一个可用的都没有");
  if (!providers.length) {
    return { ok: false, errors, warnings, providers: [], ref: "", selected: null, chain: [] };
  }

  // 排序链：顶层 model 说了算；它空着看 x-hundun.modelOrder 第一项；都没有取第一个可用。
  const ext = (src["x-hundun"] && typeof src["x-hundun"] === "object" ? src["x-hundun"] : {}) as Record<string, unknown>;
  const orderRaw = Array.isArray(ext.modelOrder) ? ext.modelOrder : [];

  const known = new Map<string, { p: ProviderEntry; m: ModelEntry }>();
  for (const p of providers) for (const m of p.models) known.set(`${p.id}/${m.id}`, { p, m });
  const toItem = ({ p, m }: { p: ProviderEntry; m: ModelEntry }): ChainItem => ({
    providerId: p.id,
    providerName: p.name,
    modelId: m.id,
    modelName: m.name,
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    contextWindow: m.context,
  });

  let head = String(src.model || "").trim();
  if (!head) {
    const firstInOrder = orderRaw.map((r) => String(r || "").trim()).find((s) => s.length > 0);
    if (firstInOrder) head = firstInOrder;
    else {
      const firstP = providers[0];
      const firstM = firstP && firstP.models[0];
      head = firstP && firstM ? `${firstP.id}/${firstM.id}` : "";
      if (head) warnings.push(`顶层没写 model，先按第一个用：${head}`);
    }
  }

  let selected: ChainItem | null = null;
  const parsed = splitRef(head);
  if (!parsed) errors.push(`model 要写成 "provider/model" 的形式（现在是 "${head}"）`);
  else {
    const p = providers.find((x) => x.id === parsed.providerId);
    if (!p) errors.push(`model 指向的 provider 不存在：${parsed.providerId}`);
    else {
      const m = p.models.find((x) => x.id === parsed.modelId);
      if (!m) errors.push(`${parsed.providerId} 下面没有这个模型：${parsed.modelId}`);
      else selected = toItem({ p, m });
    }
  }

  // 备用链：顺序里除首选之外的。引用不到的只丢一项、记警告，不整份报错——
  // 少一个备用模型不该让整个配置不可用，那会把「备用」变成「负担」。
  const chain: ChainItem[] = selected ? [selected] : [];
  for (const raw of orderRaw) {
    const ref = String(raw || "").trim();
    if (!ref || ref === head) continue;
    if (chain.some((c) => `${c.providerId}/${c.modelId}` === ref)) continue;
    const hit = known.get(ref);
    if (hit) chain.push(toItem(hit));
    else warnings.push(`顺序里的 "${ref}" 找不到对应模型，已跳过`);
  }

  return { ok: errors.length === 0, errors, warnings, providers, ref: head, selected, chain };
}

/** 依次尝试的整条链。只有一个模型时就是它自己。 */
export function chainOf(raw: unknown, opts = {}): ChainItem[] {
  const r = normalize(raw, opts);
  return r.ok ? r.chain : [];
}

/** JSON 里的顺序（首选在前）。规则与 normalize 一致：顶层 model 永远提到最前。 */
export function orderOf(json: Record<string, unknown>): string[] {
  const ext = (json["x-hundun"] && typeof json["x-hundun"] === "object" ? json["x-hundun"] : {}) as Record<string, unknown>;
  const list = Array.isArray(ext.modelOrder) ? (ext.modelOrder as unknown[]).map(String) : [];
  const out: string[] = [];
  const head = String((json.model as string) || "").trim();
  if (head) out.push(head);
  for (const raw of list) {
    const ref = String(raw || "").trim();
    if (ref && !out.includes(ref)) out.push(ref);
  }
  return out;
}

/** 把顺序写回去：x-hundun.modelOrder 是源，顶层 model 是它的第一项。 */
export function withOrder(json: Record<string, unknown>, refs: string[]): Record<string, unknown> {
  const out = JSON.parse(JSON.stringify(json)) as Record<string, unknown>;
  const list: string[] = [];
  for (const raw of refs) {
    const ref = String(raw || "").trim();
    if (ref && !list.includes(ref)) list.push(ref);
  }
  const ext = (out["x-hundun"] && typeof out["x-hundun"] === "object" ? out["x-hundun"] : {}) as Record<string, unknown>;
  out["x-hundun"] = { ...ext, modelOrder: list };
  if (list.length) out.model = list[0];
  else delete out.model;
  return out;
}

export function moveModel(json: Record<string, unknown>, ref: string, to: number): { ok: boolean; config?: Record<string, unknown>; error?: string } {
  const list = orderOf(json);
  const i = list.indexOf(String(ref || "").trim());
  if (i < 0) return { ok: false, error: "这个模型不在列表里" };
  const target = Math.max(0, Math.min(list.length - 1, Number(to)));
  if (target === i) return { ok: true, config: json };
  list.splice(i, 1);
  list.splice(target, 0, ref);
  return { ok: true, config: withOrder(json, list) };
}

export function addModel(json: Record<string, unknown>, ref: string): { ok: boolean; config?: Record<string, unknown>; error?: string } {
  const s = String(ref || "").trim();
  if (!s) return { ok: false, error: "没指定模型" };
  const list = orderOf(json);
  if (list.includes(s)) return { ok: false, error: "这个模型已经在列表里了" };
  list.push(s);
  return { ok: true, config: withOrder(json, list) };
}

export function removeModel(json: Record<string, unknown>, ref: string): { ok: boolean; config?: Record<string, unknown>; error?: string } {
  const list = orderOf(json);
  const i = list.indexOf(String(ref || "").trim());
  if (i < 0) return { ok: false, error: "这个模型不在列表里" };
  if (list.length === 1) return { ok: false, error: "至少留一个模型" };
  list.splice(i, 1);
  return { ok: true, config: withOrder(json, list) };
}

/**
 * 整体替换某个 provider 的模型列表（探测回来的真实列表写回配置用）。
 * 顺序：仍然有效的旧条目在前，新条目补在后面——用户排过的序不被一次刷新打乱。
 */
export function setProviderModels(
  json: Record<string, unknown>,
  providerId: string,
  models: Array<{ id: string; name?: string }>,
): { ok: boolean; config?: Record<string, unknown>; error?: string } {
  const pid = String(providerId || "").trim();
  const provNode = ((json.provider as Record<string, unknown> | undefined) ?? {})[pid];
  if (!provNode || typeof provNode !== "object") return { ok: false, error: `配置里没有 ${pid} 这个 provider` };
  const fresh = models.filter((m) => m && typeof m.id === "string" && m.id.trim());
  if (!fresh.length) return { ok: false, error: "模型列表是空的" };

  const out = JSON.parse(JSON.stringify(json)) as Record<string, unknown>;
  const provs = out.provider as Record<string, unknown>;
  const target = provs[pid] as Record<string, unknown>;
  const modelNode: Record<string, unknown> = {};
  for (const m of fresh) modelNode[m.id] = { name: m.name || m.id };
  target.models = modelNode;

  const known = new Set(fresh.map((m) => `${pid}/${m.id}`));
  const order = orderOf(out).filter((ref) => {
    const s = splitRef(ref);
    return s ? s.providerId !== pid || known.has(ref) : false;
  });
  for (const ref of known) if (!order.includes(ref)) order.push(ref);
  return { ok: true, config: withOrder(out, order) };
}

/**
 * opencode 式配置 → 引擎 `models.providers` 格式的翻译层（D028）。
 *
 * 这是两层格式之间的桥，hundunAgent 没有这一段（它直连模型，不翻译）。
 *
 * 翻译规则（全部在 2026-11-17 实测过，见 config.ts 的 ensureModelProvider）：
 *   provider.id                   → models.providers.<id> 的键
 *   provider.options.baseURL      → models.providers.<id>.baseUrl（须带 /v1）
 *   provider.options.apiKey       → 判断来源：{env:NAME} → ${NAME} 插值；明文 → 进 secrets
 *   provider.models 的键         → models.providers.<id>.models[].id
 *   api                          → 固定 "openai-completions"
 *   链的第一项（首选）           → agents.defaults.model.primary = "provider/model"
 *
 * 密钥纪律（延续 D027，不可改）：
 *   引擎配置里**只写 ${ENV} 插值，绝不写明文**。明文进 userData/secrets.json（0600），
 *   spawn 时注入环境变量。见 secrets.ts。
 */

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { normalize, type ChainItem, type ProviderEntry } from "./modelconfig";

export interface EngineProvider {
  baseUrl: string;
  apiKey?: string;
  api: string;
  models: { id: string; name: string }[];
}

export interface ApplyResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  /** 翻译后的引擎配置片段，供 config.ts 合并进 openclaw.json。 */
  providers: Record<string, EngineProvider>;
  /** 首选模型的 "provider/model" ref。 */
  primaryRef: string | null;
  /** 需要写进 secrets.json 的环境变量名 → 明文值。 */
  secrets: Record<string, string>;
  /** 给界面看的解析结果。 */
  parsed: {
    providers: ProviderEntry[];
    chain: ChainItem[];
  };
}

/** 判断原始 apiKey 是哪种来源，返回（来源类型，可复用的 env 名，明文）。 */
function classifyKey(rawKey: string, providerId: string): { envName: string | null; plain: string } {
  const s = String(rawKey || "").trim();
  const whole = s.match(/^\{(env|file):([^}]+)\}$/);
  if (whole && whole[1] && whole[2] !== undefined) {
    if (whole[1] === "env") return { envName: whole[2].trim(), plain: "" };
    // {file:path} 当作明文来源，真实值由 normalize 的 resolveVar 读出来，
    // 走到这里 rawKey 仍是占位符原文，plain 置空，后面从 providers 的替换后值取。
    return { envName: null, plain: "" };
  }
  return { envName: null, plain: s };
}

function providerEnvName(providerId: string): string {
  const cleaned = providerId.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  return `OPENCLAW_${cleaned}_API_KEY`;
}

/**
 * 翻译。`rawConfig` 是用户导入/手写的 opencode JSON 原文（可含 {env:}/{file:}）。
 * 先做占位符替换（env 取 process.env，file 读磁盘），再落成引擎格式。
 */
export function applyModelConfig(
  rawConfig: unknown,
  opts: { baseDir?: string; existingSecrets?: Record<string, string> } = {},
): ApplyResult {
  const warnings: string[] = [];
  const baseDir = opts.baseDir || process.cwd();
  const existingSecrets = opts.existingSecrets || {};

  const resolveVar = (kind: "env" | "file", name: string): string => {
    if (kind === "env") return process.env[name] ?? "";
    const p = isAbsolute(name) ? name : resolve(baseDir, name);
    try {
      return readFileSync(p, "utf8").trim();
    } catch {
      warnings.push(`引用的文件读不到：${p}`);
      return "";
    }
  };

  const r = normalize(rawConfig, { baseDir, resolveVar });
  if (!r.ok) {
    return { ok: false, errors: r.errors, warnings, providers: {}, primaryRef: null, secrets: {}, parsed: { providers: [], chain: [] } };
  }

  const providers: Record<string, EngineProvider> = {};
  const secrets: Record<string, string> = {};

  for (const p of r.providers) {
    const rawKey = readRawApiKey(rawConfig, p.id);
    const { envName } = classifyKey(rawKey, p.id);
    // p.apiKey 是替换后的真实值（env 已取 process.env，file 已读文件，明文原样）。
    const realValue = p.apiKey;

    const engineProvider: EngineProvider = {
      baseUrl: p.baseUrl,
      api: "openai-completions",
      models: p.models.map((m) => ({ id: m.id, name: m.name })),
    };

    if (envName) {
      // {env:NAME} 来源：引擎配置写 ${NAME} 插值；若当前环境/已有 secrets 有值就带过去。
      engineProvider.apiKey = `\${${envName}}`;
      const real = realValue || existingSecrets[envName] || "";
      if (real) secrets[envName] = real;
      else warnings.push(`${p.id} 的密钥来自环境变量 ${envName}，但当前没有值，会 401`);
    } else if (realValue) {
      // 明文或 {file:} 来源：不进引擎配置，改存 secrets.json，用稳定可读的 env 名。
      const name = providerEnvName(p.id);
      engineProvider.apiKey = `\${${name}}`;
      secrets[name] = realValue;
    }
    // 两者都没有（本地模型）：不写 apiKey，也不塞 secrets。

    providers[p.id] = engineProvider;
  }

  const head = r.chain[0];
  const primaryRef = head ? `${head.providerId}/${head.modelId}` : null;

  return {
    ok: true,
    errors: r.errors,
    warnings,
    providers,
    primaryRef,
    secrets,
    parsed: { providers: r.providers, chain: r.chain },
  };
}

/** 从原始配置里读某个 provider 的原始 apiKey（未替换的原文）。 */
function readRawApiKey(raw: unknown, providerId: string): string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "";
  const prov = (raw as Record<string, unknown>).provider;
  if (!prov || typeof prov !== "object") return "";
  const conf = (prov as Record<string, unknown>)[providerId];
  if (!conf || typeof conf !== "object") return "";
  const options = (conf as Record<string, unknown>).options;
  if (!options || typeof options !== "object") return "";
  const key = (options as Record<string, unknown>).apiKey;
  return typeof key === "string" ? key : "";
}

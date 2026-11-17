/**
 * 验证元数据透传（D028 修复）：limit.* → 引擎模型行 contextWindow/maxTokens。
 * 直接跑构建产物 dist/，验证的就是将要发布的那份代码。不碰磁盘、不发请求。
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { applyModelConfig } = require("/home/wuqi/code/hundun-agent-oc/dist/main/engine/modelapply.js");
const { setProviderModels, normalize } = require("/home/wuqi/code/hundun-agent-oc/dist/main/engine/modelconfig.js");
const { claudeToOpencode, ensureOpencode } = require("/home/wuqi/code/hundun-agent-oc/dist/main/engine/claudeconfig.js");

let failed = 0;
function ok(cond, label) {
  if (cond) console.log(`  ok  ${label}`);
  else { console.log(`FAIL  ${label}`); failed++; }
}

// ---------- 1. claude 式（用户真实配置形状）→ anthropic-messages 行带 maxTokens 32000 ----------
console.log("\n[1] claude 式转换 + apply：缺上限时 anthropic-messages 补 32000");
const claudeCfg = {
  $schema: "https://json.schemastore.org/claude-code-settings.json",
  env: {
    ANTHROPIC_BASE_URL: "https://cn.sidrune.ai",
    ANTHROPIC_AUTH_TOKEN: "sk-test-000",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  },
};
const { config: mid, format } = ensureOpencode(claudeCfg);
ok(format === "claude", "识别为 claude 式");
const r1 = applyModelConfig(mid, {});
ok(r1.ok, "apply 成功");
const ap = r1.providers["anthropic"];
ok(ap && ap.api === "anthropic-messages", `api 透传 anthropic-messages（实际 ${ap && ap.api}）`);
ok(ap.models.length === 1, "占位模型 1 个");
const m1 = ap.models[0];
ok(m1.maxTokens === 32000, `缺上限补 maxTokens 32000（实际 ${m1.maxTokens}）`);
ok(m1.contextWindow === undefined, "没编 contextWindow（缺省时不留字段）");
ok(ap.apiKey === "${OPENCLAW_ANTHROPIC_API_KEY}", "apiKey 只写插值");
ok(r1.secrets["OPENCLAW_ANTHROPIC_API_KEY"] === "sk-test-000", "明文进 secrets");

// ---------- 2. opencode 式 limit.* 透传 ----------
console.log("\n[2] opencode 式：limit.context/output → contextWindow/maxTokens");
const ocCfg = {
  provider: {
    ds: {
      options: { baseURL: "https://api.deepseek.com/v1", apiKey: "sk-x" },
      models: {
        a: { name: "A", limit: { context: 128000, output: 8192 } },
        b: { name: "B" },
      },
    },
  },
  model: "ds/a",
};
const r2 = applyModelConfig(ocCfg, {});
ok(r2.ok, "apply 成功");
const dp = r2.providers["ds"];
const ma = dp.models.find((x) => x.id === "a");
const mb = dp.models.find((x) => x.id === "b");
ok(ma.contextWindow === 128000 && ma.maxTokens === 8192, `a：128000/8192 透传（实际 ${ma.contextWindow}/${ma.maxTokens}）`);
ok(mb.contextWindow === undefined && mb.maxTokens === undefined, "b：无 limit 不写字段（openai 侧保持不发 max_tokens）");
ok(dp.api === "openai-completions", "opencode 式缺省 api 是 openai-completions");

// ---------- 3. opencode 式 + api: anthropic-messages + 无上限 → 也补 32000 ----------
console.log("\n[3] opencode 式手写 api=anthropic-messages：无上限同样补 32000");
const ocAnthropic = {
  provider: {
    relay: {
      api: "anthropic-messages",
      options: { baseURL: "https://relay.example.com", apiKey: "{env:RELAY_KEY}" },
      models: { m: { name: "M" } },
    },
  },
  model: "relay/m",
};
const r3 = applyModelConfig(ocAnthropic, {});
const rm = r3.providers["relay"].models[0];
ok(rm.maxTokens === 32000, `anthropic 无上限补 32000（实际 ${rm.maxTokens}）`);

// ---------- 4. setProviderModels 保留旧 limit ----------
console.log("\n[4] 探测刷新模型列表：存活旧条目的 limit 随行保留");
const json4 = {
  provider: { p: { options: { baseURL: "https://x/v1" }, models: { old: { name: "Old", limit: { context: 64000, output: 4096 } }, gone: { name: "Gone" } } } },
  model: "p/old",
  "x-hundun": { modelOrder: ["p/old", "p/gone"] },
};
const s = setProviderModels(json4, "p", [{ id: "old" }, { id: "fresh", name: "Fresh" }]);
ok(s.ok, "setProviderModels 成功");
const rows = s.config.provider.p.models;
ok(rows.old.limit && rows.old.limit.context === 64000 && rows.old.limit.output === 4096, "旧条目 limit 保留");
ok(rows.gone === undefined, "消失的条目被移除");
ok(rows.fresh && !rows.fresh.limit, "新条目不编 limit");

// ---------- 5. 往返：apply → 反向读 → 再 apply，元数据不丢 ----------
console.log("\n[5] apply → readSavedProviders 语义 → 再 apply：元数据不丢");
const r5 = applyModelConfig(ocCfg, {});
const row5 = r5.providers["ds"].models.find((x) => x.id === "a");
// 模拟 readSavedProviders 的读回（contextWindow/maxTokens → context/output）
const back = { context: row5.contextWindow ?? 0, output: row5.maxTokens ?? 0 };
const again = applyModelConfig({
  provider: { ds: { options: { baseURL: "https://api.deepseek.com/v1", apiKey: "sk-x" }, models: { a: { name: "A", limit: { context: back.context || undefined, output: back.output || undefined } } } } },
  model: "ds/a",
}, {});
const row5b = again.providers["ds"].models[0];
ok(row5b.contextWindow === 128000 && row5b.maxTokens === 8192, `往返后仍是 128000/8192（实际 ${row5b.contextWindow}/${row5b.maxTokens}）`);

console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);

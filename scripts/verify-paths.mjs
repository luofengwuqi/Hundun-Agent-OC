/**
 * 路径一致性回归（D031）：壳以为的 workspace 必须 == 引擎实际解析的 workspace。
 *
 * 这个错位曾导致「开发者重置记忆」删了空目录，真正的记忆纹丝不动，
 * 用户重置后模型仍记得旧对话。这里把引擎的解析规则复刻成断言钉死。
 */
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { resolveEnginePaths } = require("/home/wuqi/code/hundun-agent-oc/dist/main/engine/paths.js");

let failed = 0;
const ok = (cond, label) => {
  console.log(`${cond ? "  ok  " : "FAIL  "}${label}`);
  if (!cond) failed++;
};

// dev 模式要给一个真实存在的引擎入口，否则 resolveDevEngineRoot 会抛。
const root = "/tmp/hundun-paths-check";
const env = {
  ...process.env,
  OPENCLAW_DEV_ENGINE: "/home/wuqi/code/openclaw",
};
const paths = resolveEnginePaths({
  userData: join(root, "userData"),
  documents: join(root, "documents"),
  appRoot: root,
  isPackaged: false,
  env,
});

const expectedHome = join(root, "documents", "馄饨Agent-OC");
const expectedState = join(expectedHome, "state");
const expectedWorkspace = join(expectedState, "workspace");

console.log("\n[1] 壳的路径");
ok(paths.engineHome === expectedHome, `engineHome = ${paths.engineHome}`);
ok(paths.stateDir === expectedState, `stateDir = ${paths.stateDir}`);
ok(paths.workspace === expectedWorkspace, `workspace = ${paths.workspace}`);

console.log("\n[2] 与引擎解析规则一致（复刻 workspace-default-path.ts:17）");
// 引擎：设了 OPENCLAW_STATE_DIR 时，workspace = join(resolveStateDir(env), "workspace")
const engineWorkspace = join(env.OPENCLAW_STATE_DIR ?? paths.stateDir, "workspace");
ok(
  paths.workspace === engineWorkspace,
  `壳 workspace == 引擎解析：${paths.workspace} / ${engineWorkspace}`,
);

console.log("\n[3] 不能是 engineHome/workspace（旧的错误路径）");
ok(
  paths.workspace !== join(expectedHome, "workspace"),
  "workspace 不是 engineHome 下的空目录",
);

console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);

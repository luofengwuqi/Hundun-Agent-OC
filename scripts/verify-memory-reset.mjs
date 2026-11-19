/**
 * 重置记忆模块单测：用临时目录跑，绝不碰用户真实记忆。
 * 验证：删的是 memory/ + DREAMS.md，人格文件保留，备份生成，session key 换新。
 */
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, readFile, readdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { resetMemory } = require("/home/wuqi/code/hundun-agent-oc/dist/main/engine/memoryreset.js");

let failed = 0;
const ok = (cond, label) => { console.log(`${cond ? "  ok  " : "FAIL  "}${label}`); if (!cond) failed++; };
const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

const root = await mkdtemp(join(tmpdir(), "reset-mem-"));
const paths = {
  engineHome: join(root, "engineHome"),
  workspace: join(root, "engineHome", "workspace"),
  dataDir: join(root, "data"),
};
await mkdir(paths.workspace, { recursive: true });
await mkdir(join(paths.workspace, "memory", "dreaming"), { recursive: true });
await mkdir(paths.dataDir, { recursive: true });
for (const f of ["SOUL.md", "IDENTITY.md", "USER.md", "AGENTS.md"]) {
  await writeFile(join(paths.workspace, f), `# ${f}\nkeep me\n`);
}
await writeFile(join(paths.workspace, "memory", "2026-11-19.md"), "a diary\n");
await writeFile(join(paths.workspace, "memory", "dreaming", "x.json"), "{}\n");
await writeFile(join(paths.workspace, "DREAMS.md"), "dream\n");
await writeFile(join(paths.dataDir, "session.json"), '{"sessionKey":"hundun-old"}\n');

const r = await resetMemory(paths);
console.log("\n[1] 重置结果");
ok(r.ok, `reset ok ${r.error || ""}`);
ok(r.removed.includes("workspace/memory/") && r.removed.includes("workspace/DREAMS.md"), "删对目标");

console.log("\n[2] 删除与保留");
ok(!(await exists(join(paths.workspace, "memory"))), "memory/ 已删");
ok(!(await exists(join(paths.workspace, "DREAMS.md"))), "DREAMS.md 已删");
for (const f of ["SOUL.md", "IDENTITY.md", "USER.md", "AGENTS.md"]) {
  ok(await exists(join(paths.workspace, f)), `${f} 保留`);
}

console.log("\n[3] 备份");
ok(Boolean(r.backupDir) && await exists(r.backupDir), "备份目录存在");
ok(await exists(join(r.backupDir, "memory", "2026-11-19.md")), "记忆日志在备份里");
ok(await exists(join(r.backupDir, "DREAMS.md")), "梦日记在备份里");
ok((await readFile(join(r.backupDir, "session.json"), "utf8")).includes("hundun-old"), "旧 session key 在备份里");

console.log("\n[4] 新会话 key");
const session = JSON.parse(await readFile(join(paths.dataDir, "session.json"), "utf8"));
ok(session.sessionKey !== "hundun-old" && session.sessionKey.startsWith("hundun-"), `key 已换：${session.sessionKey}`);

console.log("\n[5] 路径白名单：workspace 名字不对时拒绝");
const bad = await resetMemory({ ...paths, workspace: join(root, "elsewhere") });
ok(!bad.ok && /拒绝删除/.test(bad.error || ""), `拒绝：${bad.error}`);

console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);

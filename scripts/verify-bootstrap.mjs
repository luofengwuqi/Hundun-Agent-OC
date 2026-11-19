/**
 * BOOTSTRAP 仪式回归：用临时目录跑，绝不碰用户真实 workspace。
 * 验证：pending 判定、注入位置、完成标记的流式过滤（不泄漏/不吞字）、
 *       标记剥离、删文件幂等、ensure 不覆盖。
 */
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, writeFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const mod = require("/home/wuqi/code/hundun-agent-oc/dist/main/engine/bootstrap.js");
const {
  BOOTSTRAP_TEMPLATE,
  applyBootstrap,
  createDoneFilter,
  ensureBootstrap,
  hasDoneMarker,
  isBootstrapPending,
  removeBootstrap,
  stripDoneMarker,
} = mod;

let failed = 0;
const ok = (cond, label) => {
  console.log(`${cond ? "  ok  " : "FAIL  "}${label}`);
  if (!cond) failed++;
};
const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

const root = await mkdtemp(join(tmpdir(), "hundun-boot-"));
const paths = {
  engineHome: join(root, "engineHome"),
  workspace: join(root, "engineHome", "workspace"),
  dataDir: join(root, "data"),
};
await mkdir(paths.workspace, { recursive: true });
const bootPath = join(paths.workspace, "BOOTSTRAP.md");

console.log("\n[1] pending 判定");
ok((await isBootstrapPending(paths)) === false, "没有文件时不是 pending");
ok((await ensureBootstrap(paths)) === true, "ensure 种下仪式");
ok((await isBootstrapPending(paths)) === true, "有文件时 pending");
ok((await ensureBootstrap(paths)) === false, "ensure 不覆盖已有仪式");

console.log("\n[2] 注入到最后一条用户消息");
const history = [
  { role: "system", content: "sys" },
  { role: "user", content: "第一句" },
  { role: "assistant", content: "回一句" },
  { role: "user", content: "当前这句" },
];
const applied = await applyBootstrap(paths, history);
ok(applied.messages.length === history.length, "轮数不变");
ok(applied.messages[0].content === "sys", "system 消息不动");
ok(applied.messages[1].content === "第一句", "历史用户消息不动");
ok(applied.messages[3].content.includes("仪式进行中"), "最后一条注入了仪式");
ok(applied.messages[3].content.endsWith("用户说：当前这句"), "原始用户输入在末尾");
ok(!history[3].content.includes("仪式进行中"), "原数组没被改写");

console.log("\n[3] 流式过滤：标记跨 chunk");
const shown = [];
const filter = createDoneFilter((s) => shown.push(s), true);
const whole = "好，我们就像平常那样聊。\n[[BOOTSTRAP_DONE]]\n";
// 故意把标记拆成容易出界的几段
for (const piece of ["好，我们就像平", "常那样聊。\n[[BOO", "TSTRAP_DONE", "]]\n"]) {
  filter.push(piece);
}
const finished = filter.finish();
const visible = shown.join("");
ok(finished === true, "识别到完成标记");
ok(!visible.includes("BOOTSTRAP"), "标记没泄漏到界面");
ok(visible.includes("我们就像平常那样聊"), "正文完整吐出");
ok(!visible.includes("[["), "方括号没漏");

console.log("\n[4] 流式过滤：没有标记时不吞字");
const shown2 = [];
const filter2 = createDoneFilter((s) => shown2.push(s), true);
for (const piece of ["普通回复，包含 [", "[ 这种字符，还有 [[BOOTSTR", "AP 但没写完。"]) {
  filter2.push(piece);
}
filter2.finish();
ok(shown2.join("") === "普通回复，包含 [[ 这种字符，还有 [[BOOTSTRAP 但没写完。", "原样吐出，不吞字");

console.log("\n[5] 标记识别与剥离");
ok(hasDoneMarker("前面\n[[BOOTSTRAP_DONE]]\n"), "识别带换行的标记");
ok(!hasDoneMarker("我们在聊 BOOTSTRAP 这个词"), "普通文字不误判");
ok(stripDoneMarker("正文\n[[BOOTSTRAP_DONE]]\n").trim() === "正文", "标记被剥掉");

console.log("\n[6] 仪式退役：删文件幂等");
await removeBootstrap(paths);
ok(!(await exists(bootPath)), "仪式文件已删");
ok((await isBootstrapPending(paths)) === false, "不再 pending");
await removeBootstrap(paths);
ok(!(await exists(bootPath)), "重复删不报错");

console.log("\n[7] 模板内容");
ok(BOOTSTRAP_TEMPLATE.includes("一次只问一个问题"), "仪式是逐问式");
ok(BOOTSTRAP_TEMPLATE.includes("[[BOOTSTRAP_DONE]]"), "模板写明完成方式");
ok(BOOTSTRAP_TEMPLATE.length > 400, "模板不是空壳");

console.log("\n[8] 路径白名单");
let refused = false;
try { await isBootstrapPending({ ...paths, workspace: join(root, "elsewhere") }); }
catch { refused = true; }
ok(refused, "workspace 名字不对时拒绝");

await rm(root, { recursive: true, force: true });
console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);

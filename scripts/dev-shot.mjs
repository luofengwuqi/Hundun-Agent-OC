#!/usr/bin/env node
/**
 * 开发期截图：通过 CDP 给运行中的窗口拍照，并打印页面可见文本。
 *
 * 为什么要有这个：改完界面要证明「真的渲染出来了」，而不是只看构建成功。
 * 构建成功但页面白屏、或者某块被顶出视口，都只有截一张才看得见。
 *
 * 用法：
 *   node scripts/dev-launch.mjs --remote-debugging-port=19222   # 另开一个终端
 *   node scripts/dev-shot.mjs --out /tmp/a.png
 *   node scripts/dev-shot.mjs --out /tmp/b.png --click "设置"   # 先点一下再拍
 *   node scripts/dev-shot.mjs --out /tmp/c.png --eval "location.reload()"
 */
import { writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const port = opt("port", "19222");
const out = opt("out", "/tmp/hundun-shot.png");
const clickText = opt("click", null);
const evalJs = opt("eval", null);

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === "page");
if (!page) {
  console.error("没找到 page target。拿到了：", targets.map((t) => t.type));
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
/**
 * 每个 CDP 调用都带超时。
 * 起因：窗口被隐藏后 Page.captureScreenshot 会一直挂着不返回（没有可截的合成帧），
 * 脚本就那么卡死了——而「隐藏窗口」恰恰是托盘那一套要验证的行为，最容易撞上。
 */
const send = (method, params = {}, timeoutMs = 5000) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP 超时 ${timeoutMs}ms：${method}`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    ws.send(JSON.stringify({ id, method, params }));
  });

ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  const slot = msg.id && pending.get(msg.id);
  if (!slot) return;
  pending.delete(msg.id);
  if (msg.error) slot.reject(new Error(msg.error.message));
  else slot.resolve(msg.result);
});

await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve);
  ws.addEventListener("error", reject);
});

const evaluate = async (expression) => {
  const { result } = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return result.value;
};

if (evalJs) {
  // 把返回值打出来。之前这里丢弃了结果，导致「查页面内部状态」只能靠截图猜——
  // 而破图、CSP 拦截这类问题在截图上看得见、在文本里看不见。
  console.log("eval →", JSON.stringify(await evaluate(evalJs), null, 1));
  await new Promise((r) => setTimeout(r, 600));
}

if (clickText) {
  const clicked = await evaluate(`(() => {
    const all = [...document.querySelectorAll('button, .rail-item, a')];
    const hit = all.find((el) => (el.innerText || '').trim().includes(${JSON.stringify(clickText)}));
    if (!hit) return false;
    hit.click();
    return true;
  })()`);
  if (!clicked) {
    console.error(`没找到可点的「${clickText}」`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 500));
}

// 窗口被隐藏时截图会超时（没有合成帧），这不算错误——调用方可能就是想验隐藏行为
let saved = false;
try {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(out, Buffer.from(data, "base64"));
  saved = true;
} catch (error) {
  console.warn(`截图跳过：${error.message}`);
}

const summary = await evaluate(`(() => {
  const main = document.querySelector('.messages') || document.querySelector('.hx-set');
  return JSON.stringify({
    url: location.href.split('/').pop(),
    visibility: document.visibilityState,
    scrollTop: main ? main.scrollTop : null,
    scrollHeight: main ? main.scrollHeight : null,
    clientHeight: main ? main.clientHeight : null,
    text: (document.body.innerText || '').slice(0, 700)
  }, null, 1);
})()`);

console.log(summary);
console.log(saved ? `已保存: ${out}` : "（未保存截图）");
ws.close();

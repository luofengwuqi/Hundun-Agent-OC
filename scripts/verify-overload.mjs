/**
 * 用真实引擎抓到的 SSE 字节回放「上游过载」路径：
 *   HTTP 200 + data: {"error":{"message":"upstream provider overloaded","code":"502"}}
 * 断言 streamChat 抛 overload 类错误且文案是人话。
 */
import { createRequire } from "node:module";
import http from "node:http";

const require = createRequire(import.meta.url);
const { streamChat, ChatError } = require("/home/wuqi/code/hundun-agent-oc/dist/main/engine/chat.js");

const FRAMES = [
  'data: {"id":"chatcmpl_x","object":"chat.completion.chunk","created":1794980195,"model":"openclaw/default","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
  'data: {"error":{"message":"upstream provider overloaded","type":"api_error","code":"502"}}\n\n',
  "data: [DONE]\n\n",
];

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const f of FRAMES) res.write(f);
  res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

let failed = 0;
try {
  await streamChat({
    port,
    token: "t",
    sessionKey: "k",
    messages: [{ role: "user", content: "hi" }],
    onDelta: () => {},
  });
  console.log("FAIL  没抛错（应该抛 overload）");
  failed++;
} catch (e) {
  const pass =
    e instanceof ChatError &&
    e.kind === "overload" &&
    /上游服务商过载/.test(e.message) &&
    /502/.test(e.message);
  console.log(`${pass ? "ok  " : "FAIL"}  kind=${e.kind} message=${e.message}`);
  if (!pass) failed++;
} finally {
  server.close();
}
process.exit(failed ? 1 : 0);

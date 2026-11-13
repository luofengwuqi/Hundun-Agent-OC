/* 渲染进程：只显示状态，不做判断。所有能力经 preload 的白名单 api。 */
const el = {
  dot: document.getElementById("dot"),
  text: document.getElementById("status-text"),
  meta: document.getElementById("meta"),
  notice: document.getElementById("notice-wrap"),
  logs: document.getElementById("logs"),
  logCount: document.getElementById("log-count"),
  toast: document.getElementById("toast"),
  restart: document.getElementById("btn-restart"),
  workspace: document.getElementById("btn-workspace"),
  datadir: document.getElementById("btn-datadir"),
};

const STATUS_LABEL = {
  booting: "正在准备…",
  starting: "正在启动陪伴引擎…",
  ready: "已经在这里了",
  failed: "没能起来",
  stopped: "已停止",
};

let toastTimer;

function toast(message) {
  el.toast.textContent = message;
  el.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove("show"), 2200);
}

function render(state) {
  const status = state.status || "booting";
  el.dot.className = `dot ${status}`;
  el.text.textContent = STATUS_LABEL[status] || status;

  const bits = [];
  if (state.port) bits.push(`端口 ${state.port}`);
  if (state.pid) bits.push(`进程 ${state.pid}`);
  if (state.adopted) bits.push("接管了上次的实例");
  el.meta.textContent = bits.join(" · ");

  el.notice.replaceChildren();
  if (state.failure) {
    const box = document.createElement("div");
    box.className = "notice failure";
    box.textContent = `${state.failure.userMessage}\n\n${state.failure.detail || ""}`.trim();
    el.notice.append(box);
  } else if (state.notice) {
    const box = document.createElement("div");
    box.className = "notice";
    box.textContent = state.notice;
    el.notice.append(box);
  }

  el.restart.disabled = status === "starting";
  if (Array.isArray(state.logs)) renderLogs(state.logs);
}

/**
 * 日志区是 <main>（可滚动）里的一个子块。任何改动日志内容的动作——包括重设 textContent
 * 和设 logs.scrollTop——都会触发浏览器的滚动锚定，把外层 main 一起滚下去，
 * 结果最重要的「引擎状态」卡被顶出视口，看起来像没启动成功。
 * 所以每次动日志前记住 main.scrollTop，动完再还回去。
 */
const scroller = document.querySelector("main");

function keepMainScroll(mutate) {
  const keep = scroller.scrollTop;
  mutate();
  if (scroller.scrollTop !== keep) scroller.scrollTop = keep;
}

// 每 3 秒兜底刷新一次；若日志没变就不重建 DOM，否则用户正在看日志时滚动条会一直跳。
let lastLogsKey = null;

function renderLogs(lines) {
  if (!lines.length) return;
  // 环形缓冲封顶后长度不再变化，末行是唯一可靠的「有新内容」信号
  const key = `${lines.length}\u0000${lines[lines.length - 1]}`;
  if (key === lastLogsKey) return;
  lastLogsKey = key;
  keepMainScroll(() => {
    el.logs.textContent = lines.join("\n");
    el.logs.scrollTop = el.logs.scrollHeight;
    el.logCount.textContent = `${lines.length} 行`;
  });
}

function appendLog(line) {
  const atBottom = el.logs.scrollTop + el.logs.clientHeight >= el.logs.scrollHeight - 24;
  keepMainScroll(() => {
    if (el.logs.textContent === "（等待引擎输出）") el.logs.textContent = "";
    el.logs.textContent += (el.logs.textContent ? "\n" : "") + line;
    if (atBottom) el.logs.scrollTop = el.logs.scrollHeight;
  });
}

async function refresh() {
  try {
    render(await window.shellApi.getState());
  } catch (error) {
    el.text.textContent = "界面与主进程失联";
    el.dot.className = "dot failed";
  }
}

el.restart.addEventListener("click", async () => {
  el.restart.disabled = true;
  try {
    render(await window.shellApi.restartEngine());
    toast("已重启");
  } catch (error) {
    toast(`重启失败：${error.message || error}`);
  } finally {
    el.restart.disabled = false;
  }
});

el.workspace.addEventListener("click", async () => {
  const path = await window.shellApi.openWorkspace();
  toast("已打开记忆目录");
});

el.datadir.addEventListener("click", async () => {
  await window.shellApi.openDataDir();
  toast("已打开数据目录");
});

window.shellApi.onState((state) => render(state));
window.shellApi.onLog((line) => appendLog(line));

refresh();
// 兜底轮询：IPC 事件丢了也不至于界面永远停在旧状态
setInterval(refresh, 3000);

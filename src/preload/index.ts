/**
 * 渲染进程只能通过这里拿到能力。
 * 刻意不暴露：token、文件系统、任意 ipcRenderer。
 */
import { contextBridge, ipcRenderer } from "electron";

export interface ShellStateDto {
  status: "booting" | "starting" | "ready" | "failed" | "stopped";
  port: number | null;
  pid: number | null;
  adopted: boolean;
  notice: string | null;
  /** 记忆根（文档目录下），卸载不会删（D024）。 */
  memoryDir: string | null;
  /** 应用自己的数据（缓存、运行时记录），卸载可删。 */
  dataDir: string | null;
  failure: {
    kind: string;
    retryable: boolean;
    userMessage: string;
    detail?: string;
  } | null;
}

export interface ShellApi {
  getState(): Promise<ShellStateDto & { logs: string[] }>;
  restartEngine(): Promise<ShellStateDto & { logs: string[] }>;
  /** 记忆根（文档目录下）。用户备份的就是这个文件夹。 */
  openMemoryDir(): Promise<string>;
  /** 人格与记忆所在的 workspace。 */
  openWorkspace(): Promise<string>;
  /** 应用自己的数据目录（诊断用）。 */
  openDataDir(): Promise<string>;
  probe(): Promise<boolean>;
  /** 无边框窗口的自绘按钮用（frame: false）。 */
  winMinimize(): void;
  winClose(): void;
  /**
   * 开发期专用：走一遍「托盘退出」的收尾路径（forceQuit + app.quit）。
   * 主进程只在非打包时注册这个 IPC，所以生产包里调用它没有任何效果。
   */
  devQuit(): void;
  onState(cb: (state: ShellStateDto) => void): void;
  onLog(cb: (line: string) => void): void;
}

const api: ShellApi = {
  getState: () => ipcRenderer.invoke("shell:get-state"),
  restartEngine: () => ipcRenderer.invoke("shell:restart-engine"),
  openMemoryDir: () => ipcRenderer.invoke("shell:open-memory-dir"),
  openWorkspace: () => ipcRenderer.invoke("shell:open-workspace"),
  openDataDir: () => ipcRenderer.invoke("shell:open-data-dir"),
  probe: () => ipcRenderer.invoke("shell:probe"),
  // 这两个走 send 而不是 invoke：窗口已经在消失，没有返回值可等
  winMinimize: () => ipcRenderer.send("shell:win-minimize"),
  winClose: () => ipcRenderer.send("shell:win-close"),
  devQuit: () => ipcRenderer.send("shell:dev-quit"),
  onState: (cb) => {
    ipcRenderer.on("shell:state", (_event, state: ShellStateDto) => cb(state));
  },
  onLog: (cb) => {
    ipcRenderer.on("shell:log", (_event, line: string) => cb(line));
  },
};

contextBridge.exposeInMainWorld("shellApi", api);

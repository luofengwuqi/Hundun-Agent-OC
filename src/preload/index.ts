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
  openDataDir(): Promise<string>;
  openWorkspace(): Promise<string>;
  probe(): Promise<boolean>;
  onState(cb: (state: ShellStateDto) => void): void;
  onLog(cb: (line: string) => void): void;
}

const api: ShellApi = {
  getState: () => ipcRenderer.invoke("shell:get-state"),
  restartEngine: () => ipcRenderer.invoke("shell:restart-engine"),
  openDataDir: () => ipcRenderer.invoke("shell:open-data-dir"),
  openWorkspace: () => ipcRenderer.invoke("shell:open-workspace"),
  probe: () => ipcRenderer.invoke("shell:probe"),
  onState: (cb) => {
    ipcRenderer.on("shell:state", (_event, state: ShellStateDto) => cb(state));
  },
  onLog: (cb) => {
    ipcRenderer.on("shell:log", (_event, line: string) => cb(line));
  },
};

contextBridge.exposeInMainWorld("shellApi", api);

import { contextBridge, ipcRenderer } from "electron";
import type { AppAPI, ElectronAPI, Settings, SettingsAPI, WatchAPI, WatchStatus } from "./types/electronAPI.js";

const settings: SettingsAPI = {
  get: () => ipcRenderer.invoke("settings:get"),
  set: (value: Settings) => ipcRenderer.invoke("settings:set", value),
};

const watch: WatchAPI = {
  list: () => ipcRenderer.invoke("watch:list"),
  add: (repo: string) => ipcRenderer.invoke("watch:add", repo),
  remove: (repo: string) => ipcRenderer.invoke("watch:remove", repo),
  pollNow: () => ipcRenderer.invoke("watch:poll-now"),
  status: () => ipcRenderer.invoke("watch:status"),
  onStatus: (callback) => {
    const listener = (_event: unknown, status: WatchStatus): void => callback(status);
    ipcRenderer.on("watch:status", listener);
    return () => ipcRenderer.removeListener("watch:status", listener);
  },
};

const app: AppAPI = {
  version: () => ipcRenderer.invoke("app:version"),
  openExternal: (url: string) => ipcRenderer.invoke("app:open-external", url),
  serverInfo: () => ipcRenderer.invoke("app:server-info"),
  onNavigate: (callback) => {
    const listener = (_event: unknown, path: string): void => callback(path);
    ipcRenderer.on("app:navigate", listener);
    return () => ipcRenderer.removeListener("app:navigate", listener);
  },
  opened: (key: string) => ipcRenderer.invoke("app:opened", key),
};

const api: ElectronAPI = { settings, watch, app };
contextBridge.exposeInMainWorld("electronAPI", api);

export type { ElectronAPI };

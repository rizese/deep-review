import { contextBridge, ipcRenderer } from "electron";
import type { AppAPI, ElectronAPI, Settings, SettingsAPI, WatchAPI } from "./types/electronAPI.js";

const settings: SettingsAPI = {
  get: () => ipcRenderer.invoke("settings:get"),
  set: (value: Settings) => ipcRenderer.invoke("settings:set", value),
};

const watch: WatchAPI = {
  list: () => ipcRenderer.invoke("watch:list"),
  add: (repo: string) => ipcRenderer.invoke("watch:add", repo),
  remove: (repo: string) => ipcRenderer.invoke("watch:remove", repo),
  pollNow: () => ipcRenderer.invoke("watch:poll-now"),
};

const app: AppAPI = {
  version: () => ipcRenderer.invoke("app:version"),
  openExternal: (url: string) => ipcRenderer.invoke("app:open-external", url),
  serverInfo: () => ipcRenderer.invoke("app:server-info"),
};

const api: ElectronAPI = { settings, watch, app };
contextBridge.exposeInMainWorld("electronAPI", api);

export type { ElectronAPI };

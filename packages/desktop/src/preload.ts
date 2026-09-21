import { contextBridge, ipcRenderer } from "electron";
import type { AppAPI, AuthAPI, ElectronAPI, GithubIdentity, Settings, SettingsAPI, WatchAPI, WatchStatus } from "./types/electronAPI.js";

const auth: AuthAPI = {
  identity: () => ipcRenderer.invoke("auth:identity"),
  signIn: () => ipcRenderer.invoke("auth:sign-in"),
  cancel: () => ipcRenderer.invoke("auth:cancel"),
  signInWithToken: (token: string) => ipcRenderer.invoke("auth:token", token),
  signOut: () => ipcRenderer.invoke("auth:sign-out"),
  onChanged: (callback) => {
    const listener = (_event: unknown, identity: GithubIdentity | null): void => callback(identity);
    ipcRenderer.on("auth:changed", listener);
    return () => ipcRenderer.removeListener("auth:changed", listener);
  },
};

const settings: SettingsAPI = {
  get: () => ipcRenderer.invoke("settings:get"),
  set: (value: Settings) => ipcRenderer.invoke("settings:set", value),
};

const watch: WatchAPI = {
  searches: () => ipcRenderer.invoke("watch:searches"),
  setSearches: (config) => ipcRenderer.invoke("watch:set-searches", config),
  preview: (query: string) => ipcRenderer.invoke("watch:preview", query),
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

const api: ElectronAPI = { auth, settings, watch, app };
contextBridge.exposeInMainWorld("electronAPI", api);

export type { ElectronAPI };

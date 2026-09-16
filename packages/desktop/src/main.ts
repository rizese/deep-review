import path from "node:path";
import process from "node:process";
import { app, BrowserWindow, ipcMain, Menu, nativeImage, Notification, shell, Tray } from "electron";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import { findServer, runDaemon, stopServer } from "@deep-review/review/daemon";
import { stateDir } from "@deep-review/review/paths";
import { addWatchedRepo, readWatchConfig, watchConfigFile } from "@deep-review/review/watchConfig";
import { readWatcherState } from "@deep-review/review/watcher";
import { agentInstalled, uninstallAgent } from "@deep-review/review/launchAgent";
import { readFileSync, writeFileSync } from "node:fs";
import type { PrView } from "@deep-review/review/api";
import type { NavServer } from "@deep-review/review/daemon";
import { applyToEnvironment, readSettings, writeSettings } from "./main/settings.js";
import { startWatchLoop, type WatchLoop } from "./main/watch.js";
import type { Result, Settings, WatchedRepoEntry } from "./types/electronAPI.js";

/**
 * Deep Review as an app. The main process is the review server — the same
 * registry, store, build workers and API the CLI talks to — with the
 * watcher's poll on a timer beside it, so there is no launchd job and no
 * port to remember. The window shows the same pages the browser did, loaded
 * from the server itself (or from Vite in development), so nothing about
 * the pages changed to live here.
 */

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let server: NavServer | null = null;
let watchLoop: WatchLoop | null = null;
const log = (message: string): void => console.log(`[deep-review] ${message}`);

const ok = <T,>(data?: T): Result<T> => (data === undefined ? { success: true } : { success: true, data });
const failed = (error: unknown): Result<never> => ({ success: false, error: error instanceof Error ? error.message : String(error) });

function pageUrl(pathname = "/"): string {
  // In development the pages come from Vite (hot reload) and reach the
  // server through its proxy; packaged, the server serves the renderer build.
  const base = is.dev && process.env["ELECTRON_RENDERER_URL"] ? process.env["ELECTRON_RENDERER_URL"] : server?.url ?? "http://127.0.0.1:7331/";
  return new URL(pathname, base).href;
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: is.dev ? "Deep Review (dev)" : "Deep Review",
    // No title bar: the pool runs to the top edge and our own bar is the
    // top of the window, with the traffic lights sitting in it.
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 19 },
    icon: path.join(__dirname, "../../resources/icon.png"),
    webPreferences: { preload: path.join(__dirname, "../preload/index.js"), sandbox: false },
  });
  window.on("ready-to-show", () => window.show());
  // Links that would open a new window — GitHub, mostly — go to the browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  void window.loadURL(pageUrl("/"));
  mainWindow = window;
  return window;
}

function showWindow(pathname?: string): void {
  const existing = mainWindow;
  const window = existing ?? createWindow();
  // An open window navigates in place; a new one loads the page directly.
  if (pathname && existing) window.webContents.send("app:navigate", pathname);
  else if (pathname) void window.loadURL(pageUrl(pathname));
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

/** A new PR arrived or finished building: say so, and open it on click. */
function watchForNotifications(nav: NavServer): void {
  const announced = new Set<string>();
  nav.registry.subscribe((event) => {
    if (event.type !== "pr") return;
    const pr: PrView = event.pr;
    const mark = `${pr.key}:${pr.state}`;
    if (announced.has(mark) || !Notification.isSupported()) return;
    if (pr.state === "ready") {
      announced.add(mark);
      const note = new Notification({ title: pr.title ?? pr.key, body: `${pr.key} is ready to read` });
      note.on("click", () => showWindow(pr.path));
      note.show();
    } else if (pr.state === "failed" && pr.failure?.parked) {
      announced.add(mark);
      new Notification({ title: `${pr.key} could not be built`, body: pr.error ?? "see the index for details" }).show();
    }
  });
}

function buildTray(): void {
  const icon = nativeImage.createFromPath(path.join(__dirname, "../../resources/icon.png")).resize({ width: 18, height: 18 });
  icon.setTemplateImage(false);
  tray = new Tray(icon);
  tray.setToolTip("Deep Review");
  const refresh = (): void => {
    const held = server?.registry.count() ?? 0;
    tray?.setContextMenu(
      Menu.buildFromTemplate([
        { label: `Deep Review — ${held} PR${held === 1 ? "" : "s"}`, enabled: false },
        { label: "Open", click: () => showWindow() },
        { label: "Check GitHub now", click: () => void watchLoop?.pollNow() },
        { type: "separator" },
        { label: "Settings…", click: () => showWindow("/settings") },
        { type: "separator" },
        { label: "Quit Deep Review", click: () => app.quit() },
      ]),
    );
  };
  refresh();
  server?.registry.subscribe(refresh);
  tray.on("click", () => showWindow());
}

async function startServer(): Promise<void> {
  // A server the CLI started earlier would hold the port and the lockfile;
  // this app is the server now, so that one is asked to stop.
  if (await findServer()) {
    log("a review server is already running; taking over.");
    await stopServer();
  }
  // The launchd watcher `pr-review watch` installs would poll beside this
  // app's own loop; the app is the watcher now, so it is retired.
  if (agentInstalled()) {
    log("retiring the launchd watcher; the app polls GitHub itself.");
    uninstallAgent();
  }
  server = await runDaemon({
    onProgress: log,
    uiDir: path.join(__dirname, "../renderer"),
    workerPath: path.join(__dirname, "buildWorker.js"),
    // The worker is this same Electron binary run as plain Node.
    workerEnv: { ELECTRON_RUN_AS_NODE: "1" },
  });
  log(`serving ${server.url}`);
  watchForNotifications(server);
}

function registerIpc(): void {
  ipcMain.handle("settings:get", async (): Promise<Result<Settings>> => {
    try {
      return ok(await readSettings());
    } catch (error) {
      return failed(error);
    }
  });
  ipcMain.handle("settings:set", async (_event, settings: Settings): Promise<Result> => {
    try {
      await writeSettings(settings);
      applyToEnvironment(settings);
      app.setLoginItemSettings({ openAtLogin: settings.openAtLogin });
      return ok();
    } catch (error) {
      return failed(error);
    }
  });
  ipcMain.handle("watch:list", (): Result<WatchedRepoEntry[]> => {
    try {
      return ok(readWatchConfig().repos.map((r) => ({ repo: r.repo, query: r.query, authoredQuery: r.authoredQuery })));
    } catch (error) {
      return failed(error);
    }
  });
  ipcMain.handle("watch:add", (_event, repo: string): Result => {
    try {
      if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new Error(`${JSON.stringify(repo)} is not an owner/repo`);
      addWatchedRepo(repo);
      return ok();
    } catch (error) {
      return failed(error);
    }
  });
  ipcMain.handle("watch:remove", (_event, repo: string): Result => {
    try {
      const file = watchConfigFile();
      const doc = JSON.parse(readFileSync(file, "utf8")) as { repos?: Record<string, unknown> };
      if (doc.repos) delete doc.repos[repo];
      writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
      return ok();
    } catch (error) {
      return failed(error);
    }
  });
  ipcMain.handle("watch:poll-now", async (): Promise<Result> => {
    try {
      await watchLoop?.pollNow();
      return ok();
    } catch (error) {
      return failed(error);
    }
  });
  ipcMain.handle("app:version", () => app.getVersion());
  ipcMain.handle("app:open-external", (_event, url: string) => {
    if (/^https?:\/\//.test(url)) return shell.openExternal(url);
    return Promise.resolve();
  });
  ipcMain.handle("app:server-info", () => {
    try {
      const watcher = readWatcherState();
      return ok({ url: server?.url ?? "", stateDir: stateDir(), watching: watchLoop !== null, lastPollAt: watcher.lastPollAt ?? null });
    } catch (error) {
      return failed(error);
    }
  });
}

/**
 * In development the running binary is Electron's own. Its Dock tile and
 * Cmd-Tab tile come from NSApplication's icon, which this sets; its name
 * in the menu bar comes from the bundle, which scripts/dev-identity.mjs
 * rewrote before launch. The packaged app needs neither.
 */
function applyDevIdentity(): void {
  if (!is.dev) return;
  const icon = nativeImage.createFromPath(path.join(__dirname, "../../resources/icon.png"));
  if (!icon.isEmpty()) app.dock?.setIcon(icon);
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId("com.rizese.deepreview");
  applyDevIdentity();
  app.on("browser-window-created", (_, window) => optimizer.watchWindowShortcuts(window));

  const settings = await readSettings();
  applyToEnvironment(settings);
  registerIpc();
  try {
    await startServer();
  } catch (error) {
    log(`could not start the server: ${error instanceof Error ? error.message : String(error)}`);
  }
  watchLoop = startWatchLoop({ log });
  buildTray();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showWindow();
  });
});

// The window closing is not the app closing: the server and the watcher
// keep going in the tray, as the launchd job and the daemon did.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  watchLoop?.stop();
  if (server) void server.close();
});

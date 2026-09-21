import path from "node:path";
import process from "node:process";
import { app, BrowserWindow, ipcMain, Menu, nativeImage, Notification, shell, Tray } from "electron";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import { findServer, runDaemon, stopServer } from "@deep-review/review/daemon";
import { stateDir } from "@deep-review/review/paths";
import { readWatchConfig, writeWatchConfig } from "@deep-review/review/watchConfig";
import { parseSearchInput, searchPrs, type PrSearch } from "@deep-review/pr";
import { readWatcherState } from "@deep-review/review/watcher";
import { agentInstalled, uninstallAgent } from "@deep-review/review/launchAgent";
import type { PrView } from "@deep-review/review/api";
import type { NavServer } from "@deep-review/review/daemon";
import { startBadge, type Badge } from "./main/badge.js";
import { cliToken, clientIdOf, identityOf, needsRefresh, refreshGrant, startDeviceFlow, waitForToken, type TokenGrant } from "./main/githubAuth.js";
import { applyToEnvironment, readSettings, writeSettings } from "./main/settings.js";
import { hasGithubToken, startWatchLoop, type WatchLoop } from "./main/watch.js";
import type { DevicePrompt, GithubIdentity, Result, SearchConfig, SearchPreview, Settings, WatchStatus } from "./types/electronAPI.js";

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
let badge: Badge | null = null;
/** The device-flow wait in progress, so a second attempt or a quit can call it off. */
let signingIn: AbortController | null = null;
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
    trafficLightPosition: { x: 16, y: 21 },
    icon: path.join(__dirname, "../../resources/icon.png"),
    webPreferences: { preload: path.join(__dirname, "../preload/index.js"), sandbox: false },
  });
  window.on("ready-to-show", () => window.show());
  // A link dragged onto the window would otherwise load it in place of the
  // app. The page takes PR links itself (drop or paste); anything else that
  // would carry the window away goes to the browser instead.
  window.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin === new URL(pageUrl("/")).origin) return;
    event.preventDefault();
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
  });
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
  badge = startBadge(server, {
    file: path.join(app.getPath("userData"), "seen.json"),
    setBadge: (text) => app.dock?.setBadge(text),
  });
}

/** The pages learn of the watcher's standing as it changes, not by asking. */
function tellStatus(status: WatchStatus): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("watch:status", status);
}

/**
 * Signing in to GitHub. The token a sign-in yields is kept exactly where a
 * pasted one is — the encrypted settings — so everything downstream, the
 * watcher and the server both, carries on reading GITHUB_TOKEN from the
 * environment and knows nothing about how it got there.
 */
async function storeToken(grant: TokenGrant): Promise<GithubIdentity> {
  // Ask who it is before keeping it: a token GitHub will not take is worse
  // than no token, because the watcher would keep trying it.
  const identity = await identityOf(grant.token);
  const settings = await readSettings();
  const next = {
    ...settings,
    githubToken: grant.token,
    githubRefreshToken: grant.refreshToken,
    githubTokenExpiresAt: grant.expiresAt ?? 0,
  };
  await writeSettings(next);
  applyToEnvironment(next);
  watchLoop?.refresh();
  void watchLoop?.pollNow();
  tellIdentity(identity);
  return identity;
}

/**
 * Keep the stored token usable.
 *
 * An OAuth App registered with "Expire user access tokens" issues tokens
 * good for eight hours, so a watcher left running overnight would wake up
 * to nothing but 401s. Before every poll the token is traded in if it is
 * near its end. An app registered without that setting stores no refresh
 * token and no expiry, and this does nothing at all.
 */
async function ensureFreshToken(): Promise<void> {
  const settings = await readSettings();
  const expiresAt = settings.githubTokenExpiresAt || null;
  const clientId = clientIdOf();
  if (!needsRefresh(expiresAt) || !settings.githubRefreshToken || !clientId) return;
  try {
    const grant = await refreshGrant(clientId, settings.githubRefreshToken);
    const next = {
      ...settings,
      githubToken: grant.token,
      githubRefreshToken: grant.refreshToken,
      githubTokenExpiresAt: grant.expiresAt ?? 0,
    };
    await writeSettings(next);
    applyToEnvironment(next);
    log("refreshed the GitHub token.");
  } catch (error) {
    // The refresh token is spent or revoked; signing in again is the only
    // way back, and the pages are told so the card can say it.
    log(`could not refresh the GitHub token: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function tellIdentity(identity: GithubIdentity | null): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("auth:changed", identity);
}

function registerAuthIpc(): void {
  ipcMain.handle("auth:identity", async (): Promise<Result<GithubIdentity | null>> => {
    try {
      await ensureFreshToken();
      const { githubToken } = await readSettings();
      return ok<GithubIdentity | null>(githubToken ? await identityOf(githubToken) : null);
    } catch (error) {
      return failed(error);
    }
  });
  ipcMain.handle("auth:sign-in", async (): Promise<Result<DevicePrompt>> => {
    try {
      const githubClientId = clientIdOf();
      if (!githubClientId) {
        throw new Error(
          "this build carries no OAuth client id: it was built without DEEP_REVIEW_GITHUB_CLIENT_ID. " +
            "Sign in with the GitHub CLI's token instead, or rebuild with one (see .env.example).",
        );
      }
      signingIn?.abort();
      const start = await startDeviceFlow(githubClientId);
      const controller = new AbortController();
      signingIn = controller;
      // The reader does their half in the browser; this half waits.
      void shell.openExternal(start.prompt.verificationUri);
      void waitForToken(githubClientId, start, { signal: controller.signal })
        .then((grant) => storeToken(grant))
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          log(`sign-in failed: ${error instanceof Error ? error.message : String(error)}`);
          tellIdentity(null);
        })
        .finally(() => {
          if (signingIn === controller) signingIn = null;
        });
      return ok(start.prompt);
    } catch (error) {
      return failed(error);
    }
  });
  ipcMain.handle("auth:cancel", (): Result => {
    signingIn?.abort();
    signingIn = null;
    return ok();
  });
  ipcMain.handle("auth:cli-available", async (): Promise<Result<boolean>> => {
    try {
      return ok((await cliToken()) !== null);
    } catch (error) {
      return failed(error);
    }
  });
  ipcMain.handle("auth:use-cli", async (): Promise<Result<GithubIdentity>> => {
    try {
      const token = await cliToken();
      if (!token) throw new Error("the GitHub CLI has no token to lend; run `gh auth login` first");
      // The CLI's token is the CLI's to renew; this one is simply kept.
      return ok(await storeToken({ token, expiresAt: null, refreshToken: "", refreshExpiresAt: null }));
    } catch (error) {
      return failed(error);
    }
  });
  ipcMain.handle("auth:sign-out", async (): Promise<Result> => {
    try {
      signingIn?.abort();
      signingIn = null;
      const settings = await readSettings();
      const next = { ...settings, githubToken: "", githubRefreshToken: "", githubTokenExpiresAt: 0 };
      await writeSettings(next);
      // The environment keeps a deleted key only if the process was started
      // with one; applyToEnvironment leaves that alone, so clear it here.
      delete process.env.GITHUB_TOKEN;
      applyToEnvironment(next);
      watchLoop?.refresh();
      tellIdentity(null);
      return ok();
    } catch (error) {
      return failed(error);
    }
  });
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
      const hadToken = hasGithubToken();
      await writeSettings(settings);
      applyToEnvironment(settings);
      app.setLoginItemSettings({ openAtLogin: settings.openAtLogin });
      watchLoop?.refresh();
      // A token just arrived: the first poll should not wait for the timer.
      if (!hadToken && hasGithubToken()) void watchLoop?.pollNow();
      return ok();
    } catch (error) {
      return failed(error);
    }
  });
  ipcMain.handle("watch:searches", (): Result<SearchConfig> => {
    try {
      const config = readWatchConfig();
      return ok({ review: config.review, authored: config.authored, fromDefaults: config.fromDefaults, problems: config.problems });
    } catch (error) {
      return failed(error);
    }
  });
  ipcMain.handle("watch:set-searches", (_event, config: { review: string[]; authored: string[] }): Result<SearchConfig> => {
    try {
      // What was typed may be a query or the URL of a GitHub search page,
      // which is where these get built; either way the query is what is kept.
      const clean = (list: unknown): string[] =>
        (Array.isArray(list) ? list : []).map((q) => parseSearchInput(String(q))).filter((q) => q.length > 0);
      writeWatchConfig({ review: clean(config.review), authored: clean(config.authored) });
      const saved = readWatchConfig();
      watchLoop?.refresh();
      void watchLoop?.pollNow();
      return ok({ review: saved.review, authored: saved.authored, fromDefaults: saved.fromDefaults, problems: saved.problems });
    } catch (error) {
      return failed(error);
    }
  });
  ipcMain.handle("watch:preview", async (_event, query: string): Promise<Result<SearchPreview>> => {
    try {
      // Only asks GitHub; nothing here reaches the server, so a search can
      // be judged before it is saved and starts building what it finds.
      const search: PrSearch = { role: "review", query: parseSearchInput(String(query)) };
      const found = await searchPrs([search]);
      return ok({
        count: found.length,
        sample: found.slice(0, 5).map((pr) => ({ key: `${pr.owner}/${pr.repo}#${pr.number}`, title: pr.title })),
      });
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
  ipcMain.handle("watch:status", (): Result<WatchStatus> => {
    try {
      if (!watchLoop) throw new Error("the watcher is not running");
      return ok(watchLoop.status());
    } catch (error) {
      return failed(error);
    }
  });
  ipcMain.handle("app:opened", (_event, key: string) => {
    if (typeof key === "string") badge?.opened(key);
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
  registerAuthIpc();
  try {
    await startServer();
  } catch (error) {
    log(`could not start the server: ${error instanceof Error ? error.message : String(error)}`);
  }
  watchLoop = startWatchLoop({ log, onStatus: tellStatus, before: ensureFreshToken });
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
  signingIn?.abort();
  watchLoop?.stop();
  badge?.stop();
  if (server) void server.close();
});

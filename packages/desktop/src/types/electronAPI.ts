/**
 * What the pages may ask the desktop shell for, over the preload bridge.
 * Everything the pages need about PRs comes from the server over HTTP as
 * before; this is only what a browser could not do — keep secrets, edit the
 * watch list, know the app.
 */

export interface Settings {
  githubToken: string;
  openaiApiKey: string;
  anthropicApiKey: string;
  grokApiKey: string;
  linearApiKey: string;
  /** Model id for slicing; empty means the CLI's default. */
  model: string;
  openAtLogin: boolean;
}

export interface WatchedRepoEntry {
  repo: string;
  query?: string | undefined;
  authoredQuery?: string | undefined;
}

export interface Result<T = void> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface SettingsAPI {
  get: () => Promise<Result<Settings>>;
  set: (settings: Settings) => Promise<Result>;
}

export interface WatchAPI {
  list: () => Promise<Result<WatchedRepoEntry[]>>;
  add: (repo: string) => Promise<Result>;
  remove: (repo: string) => Promise<Result>;
  /** Poll GitHub now rather than at the next interval. */
  pollNow: () => Promise<Result>;
}

export interface AppAPI {
  version: () => Promise<string>;
  openExternal: (url: string) => Promise<void>;
  /** Where the server lives and what it holds, for the settings page's status line. */
  serverInfo: () => Promise<Result<{ url: string; stateDir: string; watching: boolean; lastPollAt: number | null }>>;
  /** The shell wants a page shown — a notification was clicked, the tray asked for Settings. Returns the way to stop listening. */
  onNavigate: (callback: (path: string) => void) => () => void;
}

export interface ElectronAPI {
  settings: SettingsAPI;
  watch: WatchAPI;
  app: AppAPI;
}

declare global {
  interface Window {
    /** Present only inside the desktop app; the pages work without it. */
    electronAPI?: ElectronAPI;
  }
}

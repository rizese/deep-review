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
  openrouterApiKey: string;
  linearApiKey: string;
  /** Model id for slicing; empty means the CLI's default. */
  model: string;
  /**
   * Traded for a new token when the current one expires. Only apps
   * registered with "Expire user access tokens" ever issue one.
   */
  githubRefreshToken: string;
  /** When the GitHub token stops working; 0 when it never does. */
  githubTokenExpiresAt: number;
  openAtLogin: boolean;
}

/**
 * What the index's two tabs are built from: GitHub searches, the same ones
 * github.com/pulls takes. A list per tab because GitHub cannot OR two
 * qualifiers in one query — "assigned to me" and "review requested from me"
 * are two searches whose answers are merged.
 */
export interface SearchConfig {
  review: string[];
  authored: string[];
  /** Whether these are the defaults rather than anything chosen. */
  fromDefaults: boolean;
  /** Searches the file carried that will not be run, and why. */
  problems: string[];
}

/** What one search would find right now, without handing anything to the server. */
export interface SearchPreview {
  /** How many open PRs match. */
  count: number;
  /** A few of them, newest first, to show what was matched. */
  sample: { key: string; title: string }[];
}

/** Who the app is signed in to GitHub as. */
export interface GithubIdentity {
  login: string;
  name: string | null;
  avatarUrl: string;
  /** What the token may do, as GitHub reports it; empty when it does not say. */
  scopes: string[];
}

/** What to show the reader while the browser half of signing in happens. */
export interface DevicePrompt {
  userCode: string;
  verificationUri: string;
  expiresAt: number;
}

/** How the watcher stands: whether it can poll at all, and how its last poll went. */
export interface WatchStatus {
  /** A GitHub token is in place; without one nothing is polled. */
  hasToken: boolean;
  /** How many searches the watcher runs. */
  searches: number;
  polling: boolean;
  lastPollAt: number | null;
  /** Why the last poll failed, when it did; null after a good one. */
  lastError: string | null;
}

export interface Result<T = void> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface SettingsAPI {
  get: () => Promise<Result<Settings>>;
  /** Merged into what is stored, so a page need only send the fields it owns. */
  set: (settings: Partial<Settings>) => Promise<Result>;
}

export interface WatchAPI {
  /** The searches behind each tab. */
  searches: () => Promise<Result<SearchConfig>>;
  /** Replace them. Takes queries or pasted GitHub search URLs. */
  setSearches: (config: { review: string[]; authored: string[] }) => Promise<Result<SearchConfig>>;
  /** What one search finds right now, so it can be judged before it is saved. */
  preview: (query: string) => Promise<Result<SearchPreview>>;
  /** Poll GitHub now rather than at the next interval. */
  pollNow: () => Promise<Result>;
  status: () => Promise<Result<WatchStatus>>;
  /** The watcher's standing changed — a poll began or ended, a token was set. Returns the way to stop listening. */
  onStatus: (callback: (status: WatchStatus) => void) => () => void;
}

export interface AuthAPI {
  /** Who the stored token belongs to; null when there is no token, and an error when GitHub has stopped taking it. */
  identity: () => Promise<Result<GithubIdentity | null>>;
  /** Begin the Device Flow: the browser opens and this returns the code to show. The token lands later, on onChanged. */
  signIn: () => Promise<Result<DevicePrompt>>;
  /** Stop waiting for the reader to approve. */
  cancel: () => Promise<Result>;
  /** Sign in with a token the reader pasted — from `gh auth token`, or one they made. */
  signInWithToken: (token: string) => Promise<Result<GithubIdentity>>;
  /** Forget the token. */
  signOut: () => Promise<Result>;
  /** The signed-in identity changed. Returns the way to stop listening. */
  onChanged: (callback: (identity: GithubIdentity | null) => void) => () => void;
}

export interface AppAPI {
  version: () => Promise<string>;
  openExternal: (url: string) => Promise<void>;
  /** Where the server lives and what it holds, for the settings page's status line. */
  serverInfo: () => Promise<Result<{ url: string; stateDir: string; watching: boolean; lastPollAt: number | null }>>;
  /** The shell wants a page shown — a notification was clicked, the tray asked for Settings. Returns the way to stop listening. */
  onNavigate: (callback: (path: string) => void) => () => void;
  /** The reader opened a PR's page: it no longer counts on the Dock badge. */
  opened: (key: string) => Promise<void>;
}

export interface ElectronAPI {
  auth: AuthAPI;
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

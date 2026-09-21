/**
 * The app's settings: the secrets the server and watcher need (tokens, model
 * keys) and a couple of preferences. Kept encrypted with the OS keychain via
 * safeStorage under the app's userData, the way a browser could never do,
 * and pushed into the process environment so the review packages — which
 * read GITHUB_TOKEN, OPENAI_API_KEY and friends from the environment, as the
 * CLI does — need no change to run inside the app.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { app, safeStorage } from "electron";
import type { Settings } from "../types/electronAPI.js";

export const DEFAULT_SETTINGS: Settings = {
  githubToken: "",
  openaiApiKey: "",
  anthropicApiKey: "",
  grokApiKey: "",
  linearApiKey: "",
  model: "",
  githubClientId: "",
  githubRefreshToken: "",
  githubTokenExpiresAt: 0,
  openAtLogin: false,
};

const ENV_KEYS: Record<keyof Omit<Settings, "openAtLogin" | "model" | "githubClientId" | "githubRefreshToken" | "githubTokenExpiresAt">, string> = {
  githubToken: "GITHUB_TOKEN",
  openaiApiKey: "OPENAI_API_KEY",
  anthropicApiKey: "ANTHROPIC_API_KEY",
  grokApiKey: "GROK_API_KEY",
  linearApiKey: "LINEAR_API_KEY",
};

function settingsFile(): string {
  return path.join(app.getPath("userData"), "settings.encrypted");
}

export async function readSettings(): Promise<Settings> {
  try {
    const encrypted = await readFile(settingsFile());
    const parsed = JSON.parse(safeStorage.decryptString(encrypted)) as Partial<Settings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") console.error("could not read settings:", error);
    return { ...DEFAULT_SETTINGS };
  }
}

export async function writeSettings(settings: Settings): Promise<void> {
  await mkdir(app.getPath("userData"), { recursive: true });
  await writeFile(settingsFile(), safeStorage.encryptString(JSON.stringify(settings)));
}

/**
 * Put the secrets where the review packages look for them. A value the
 * environment already has (a developer running `pnpm dev` with a token
 * exported) wins over an empty setting, but a stored value replaces an
 * environment one — the settings page is where the app's keys are chosen.
 */
export function applyToEnvironment(settings: Settings): void {
  for (const [key, envName] of Object.entries(ENV_KEYS) as [keyof typeof ENV_KEYS, string][]) {
    const value = settings[key];
    if (value) process.env[envName] = value;
    else if (process.env[envName] === undefined) delete process.env[envName];
  }
  if (settings.model) process.env.DEEP_REVIEW_MODEL = settings.model;
  else delete process.env.DEEP_REVIEW_MODEL;
}

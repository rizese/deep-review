import { useCallback, useEffect, useState } from "react";
import type { DevicePrompt, GithubIdentity } from "../../../types/electronAPI.js";

export interface AuthNote {
  text: string;
  bad: boolean;
}

export interface GithubAuth {
  /** Who the app is signed in as, or null. */
  identity: GithubIdentity | null;
  /** The code to type into a browser while a sign-in is in flight. */
  device: DevicePrompt | null;
  /** Whether the GitHub CLI on this machine has a token to lend. */
  cli: boolean;
  busy: boolean;
  /** Whether the first answer about who this is has come back. */
  loaded: boolean;
  note: AuthNote | null;
  signIn: () => Promise<void>;
  cancel: () => Promise<void>;
  useCli: () => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

function reason(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" && error ? error : fallback;
}

/**
 * Signing in to GitHub, for whoever needs to offer it: the settings card
 * and the sign-in screen the index shows before there is a token. The
 * token itself lands in the main process long after the click that asked
 * for it, so the standing of a sign-in is worth keeping in one place.
 */
export function useGithubAuth(): GithubAuth {
  const [identity, setIdentity] = useState<GithubIdentity | null>(null);
  const [device, setDevice] = useState<DevicePrompt | null>(null);
  const [cli, setCli] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [note, setNote] = useState<AuthNote | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const api = typeof window === "undefined" ? undefined : window.electronAPI;
    if (!api) {
      setLoaded(true);
      return;
    }
    try {
      const result = await api.auth.identity();
      if (result.success) setIdentity(result.data ?? null);
      else setNote({ text: result.error ?? "could not ask GitHub who you are", bad: true });
    } catch (error) {
      setNote({ text: reason(error, "could not ask GitHub who you are"), bad: true });
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    const api = typeof window === "undefined" ? undefined : window.electronAPI;
    if (!api) {
      setLoaded(true);
      return;
    }
    let alive = true;
    void refresh();
    void api.auth.cliAvailable().then((result) => {
      if (alive && result.success) setCli(Boolean(result.data));
    });
    const stop = api.auth.onChanged((next) => {
      if (!alive) return;
      setIdentity(next);
      setDevice(null);
      setBusy(false);
      if (next) setNote({ text: `signed in as ${next.login}`, bad: false });
    });
    return () => {
      alive = false;
      stop();
    };
  }, [refresh]);

  const signIn = useCallback(async (): Promise<void> => {
    const api = window.electronAPI;
    if (!api) return;
    setBusy(true);
    setNote(null);
    try {
      const result = await api.auth.signIn();
      if (result.success && result.data) setDevice(result.data);
      else {
        setNote({ text: result.error ?? "could not start signing in", bad: true });
        setBusy(false);
      }
    } catch (error) {
      setNote({ text: reason(error, "could not start signing in"), bad: true });
      setBusy(false);
    }
  }, []);

  const cancel = useCallback(async (): Promise<void> => {
    await window.electronAPI?.auth.cancel();
    setDevice(null);
    setBusy(false);
  }, []);

  const useCli = useCallback(async (): Promise<void> => {
    const api = window.electronAPI;
    if (!api) return;
    setBusy(true);
    setNote(null);
    try {
      const result = await api.auth.useCli();
      if (result.success && result.data) {
        setIdentity(result.data);
        setDevice(null);
        setNote({ text: `signed in as ${result.data.login}`, bad: false });
      } else setNote({ text: result.error ?? "could not take the CLI's token", bad: true });
    } catch (error) {
      setNote({ text: reason(error, "could not take the CLI's token"), bad: true });
    } finally {
      setBusy(false);
    }
  }, []);

  const signOut = useCallback(async (): Promise<void> => {
    const api = window.electronAPI;
    if (!api) return;
    setBusy(true);
    const result = await api.auth.signOut();
    setNote(result.success ? null : { text: result.error ?? "could not sign out", bad: true });
    setIdentity(null);
    setDevice(null);
    setBusy(false);
  }, []);

  return { identity, device, cli, busy, loaded, note, signIn, cancel, useCli, signOut, refresh };
}

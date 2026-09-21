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
  busy: boolean;
  /** Whether the first answer about who this is has come back. */
  loaded: boolean;
  note: AuthNote | null;
  signIn: () => Promise<void>;
  cancel: () => Promise<void>;
  signInWithToken: (token: string) => Promise<boolean>;
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

  /** Answers whether it worked, so the field can clear itself only then. */
  const signInWithToken = useCallback(async (token: string): Promise<boolean> => {
    const api = window.electronAPI;
    if (!api) return false;
    setBusy(true);
    setNote(null);
    try {
      const result = await api.auth.signInWithToken(token);
      if (result.success && result.data) {
        setIdentity(result.data);
        setDevice(null);
        setNote({ text: `signed in as ${result.data.login}`, bad: false });
        return true;
      }
      setNote({ text: result.error ?? "GitHub would not take that token", bad: true });
      return false;
    } catch (error) {
      setNote({ text: reason(error, "GitHub would not take that token"), bad: true });
      return false;
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

  return { identity, device, busy, loaded, note, signIn, cancel, signInWithToken, signOut, refresh };
}

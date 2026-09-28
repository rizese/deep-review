import { useCallback, useState } from "react";

/** A string the browser remembers for this origin; the fallback when it cannot. */
export function useStored(key: string, fallback: string): [string, (value: string) => void] {
  const [value, setValue] = useState<string>(() => {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  });
  const set = useCallback(
    (next: string) => {
      setValue(next);
      try {
        if (next === fallback) localStorage.removeItem(key);
        else localStorage.setItem(key, next);
      } catch {
        // A private window: the choice lasts the page.
      }
    },
    [key, fallback],
  );
  return [value, set];
}

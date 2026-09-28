import { useEffect } from "react";
import { useStored } from "./useStored.js";

export type Theme = "light" | "dark" | "system";

/** The theme choice: stamped on the root as data-theme; "system" is its absence. */
export function useTheme(): [Theme, (t: Theme) => void] {
  const [stored, setStored] = useStored("deep-review.theme", "system");
  const theme: Theme = stored === "light" || stored === "dark" ? stored : "system";
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
  }, [theme]);
  return [theme, setStored];
}

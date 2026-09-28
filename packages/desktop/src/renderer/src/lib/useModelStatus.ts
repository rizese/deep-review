import { useCallback, useEffect, useState } from "react";
import type { ModelStatus } from "../../../types/electronAPI.js";

export interface ModelState {
  status: ModelStatus | null;
  /** Ask again — after a key is saved, or the model changed. */
  refresh: () => Promise<void>;
}

/**
 * Which model will do the slicing and whether its key is in place. Null in
 * a browser, where there is no shell holding keys and nothing to set up.
 */
export function useModelStatus(): ModelState {
  const [status, setStatus] = useState<ModelStatus | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const api = typeof window === "undefined" ? undefined : window.electronAPI;
    if (!api) return;
    try {
      const result = await api.app.model();
      if (result.success && result.data) setStatus(result.data);
    } catch {
      // The shell is not answering; the index is no place to say so.
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { status, refresh };
}

import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState, type JSX, type MouseEvent } from "react";
import type { DevicePrompt } from "../../../types/electronAPI.js";
import { Button } from "./Button.js";
import styles from "./DeviceCode.module.css";

/**
 * Put text on the clipboard. The async clipboard wants a secure context,
 * which these pages have over localhost, but a denied permission or an
 * unfocused window still throws; the old selection-and-copy works in all
 * of those and is worth keeping behind it.
 */
async function toClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const field = document.createElement("textarea");
      field.value = text;
      field.setAttribute("readonly", "");
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.appendChild(field);
      field.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(field);
      return ok;
    } catch {
      return false;
    }
  }
}

/**
 * The half of the device flow that happens in a browser.
 *
 * The code is the only thing to carry across, so the whole box copies it:
 * a click anywhere that is not another control, the copy button, or the
 * keyboard. Its own Cancel keeps its meaning.
 */
export function DeviceCode({ prompt, wide, onCancel }: { prompt: DevicePrompt; wide?: boolean; onCancel: () => void }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = async (): Promise<void> => {
    const ok = await toClipboard(prompt.userCode);
    if (!ok) return;
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  };

  // Anywhere on the box copies; its own buttons keep their meaning.
  const onBoxClick = (e: MouseEvent): void => {
    if ((e.target as Element).closest("button")) return;
    void copy();
  };

  return (
    <div
      className={`${styles.device} ${wide ? styles.wide : ""}`}
      aria-label="Finish signing in"
      title="Click to copy the code"
      onClick={onBoxClick}
    >
      <div className={styles.codeRow}>
        <span className={styles.code}>{prompt.userCode}</span>
        <button
          className={styles.copy}
          type="button"
          aria-label={copied ? "Copied" : "Copy the code"}
          data-copied={copied ? "true" : "false"}
          onClick={() => void copy()}
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        </button>
      </div>
      <span className={styles.text} aria-live="polite">
        {copied ? (
          <>
            Copied. Paste it at <strong>{prompt.verificationUri.replace(/^https?:\/\//, "")}</strong>, which is open in your browser.
          </>
        ) : (
          <>
            Type this at <strong>{prompt.verificationUri.replace(/^https?:\/\//, "")}</strong>, which is open in your browser.
          </>
        )}
      </span>
      <span className={styles.spacer} />
      <span className={styles.waiting}>
        <span className={styles.pulse} aria-hidden="true" />
        Waiting
      </span>
      <Button size="sm" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

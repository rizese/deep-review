import { useRef, type JSX, type MouseEvent } from "react";
import type { DevicePrompt } from "../../../types/electronAPI.js";
import { Button } from "./Button.js";
import { CopyButton } from "./CopyButton.js";
import styles from "./DeviceCode.module.css";

/**
 * The half of the device flow that happens in a browser.
 *
 * The code is the only thing to carry across, so the whole box copies it:
 * a click anywhere that is not another control, the copy button, or the
 * keyboard. Its own Cancel keeps its meaning.
 */
export function DeviceCode({
  prompt,
  wide,
  onCancel,
}: {
  prompt: DevicePrompt;
  wide?: boolean | undefined;
  onCancel: () => void;
}): JSX.Element {
  const copy = useRef<HTMLButtonElement>(null);
  // Anywhere on the box copies, by standing in for the copy button so the
  // two share one implementation and one "copied" moment; the box's own
  // buttons keep their meaning.
  const onBoxClick = (e: MouseEvent): void => {
    if ((e.target as Element).closest("button")) return;
    copy.current?.click();
  };

  return (
    <div
      className={`${styles.device} ${wide ? styles.wide : ""}`}
      aria-label="Finish signing in"
      title="Click to copy the code"
      onClick={onBoxClick}
    >
      <CopyButton ref={copy} text={prompt.userCode} label="Copy the code" className={styles.copy} />
      <div className={styles.codeRow}>
        <span className={styles.code}>{prompt.userCode}</span>
      </div>
      <span className={styles.text} aria-live="polite">
        Enter this code at{" "}
        <strong>{prompt.verificationUri.replace(/^https?:\/\//, "")}</strong>
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

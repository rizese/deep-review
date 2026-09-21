import type { JSX } from "react";
import type { DevicePrompt } from "../../../types/electronAPI.js";
import { Button } from "./Button.js";
import styles from "./DeviceCode.module.css";

/** The half of the device flow that happens in a browser, said plainly. */
export function DeviceCode({ prompt, wide, onCancel }: { prompt: DevicePrompt; wide?: boolean; onCancel: () => void }): JSX.Element {
  return (
    <div className={`${styles.device} ${wide ? styles.wide : ""}`} aria-label="Finish signing in">
      <span className={styles.code}>{prompt.userCode}</span>
      <span className={styles.text}>
        Type this at <strong>{prompt.verificationUri.replace(/^https?:\/\//, "")}</strong>, which is open in your browser.
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

import type { JSX } from "react";
import styles from "./Pool.module.css";

/** The water behind every page. See Pool.module.css. */
export function Pool(): JSX.Element {
  return (
    <div className={styles.pool} aria-hidden="true">
      <div className={`${styles.layer} ${styles.a}`} />
      <div className={`${styles.layer} ${styles.b}`} />
      <div className={styles.grain} />
    </div>
  );
}

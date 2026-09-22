import type { JSX, ReactNode } from "react";
import styles from "./FirstRun.module.css";

export interface Note {
  text: string;
  bad: boolean;
}

/**
 * One step of getting started, alone in the middle of the window.
 *
 * Two of these stand between a new install and a built PR — an account to
 * read from, a model to read with — and neither is a banner over an empty
 * list. They share this shell so a third would not be a third layout.
 */
export function FirstRun({
  label,
  mark,
  title,
  blurb,
  children,
  foot,
  note,
}: {
  /** What the step is, for anything not looking at the screen. */
  label: string;
  mark?: ReactNode;
  title: string;
  /** The sentence under the title saying what this step is for. */
  blurb?: ReactNode;
  children: ReactNode;
  /** The quiet line under the controls. */
  foot?: ReactNode;
  note?: Note | null | undefined;
}): JSX.Element {
  return (
    <main className={styles.screen} aria-label={label}>
      {mark && (
        <span className={styles.mark} aria-hidden="true">
          {mark}
        </span>
      )}
      <h1 className={styles.title}>{title}</h1>
      {blurb && <p className={styles.blurb}>{blurb}</p>}
      {children}
      {foot && <p className={styles.foot}>{foot}</p>}
      {note && (
        <div className={styles.note} data-bad={note.bad ? "true" : "false"}>
          {note.text}
        </div>
      )}
    </main>
  );
}

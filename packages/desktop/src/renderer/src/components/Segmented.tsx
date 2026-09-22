import type { JSX } from "react";
import styles from "./Segmented.module.css";

export interface Segment {
  id: string;
  label: string;
}

/**
 * One choice out of a few, as a single pill with the chosen segment
 * filled. Smaller than a row of buttons, and says these are alternatives
 * rather than three things you might do.
 */
export function Segmented({
  label,
  options,
  value,
  disabled,
  onChange,
}: {
  label: string;
  options: Segment[];
  value: string;
  disabled?: boolean;
  onChange: (id: string) => void;
}): JSX.Element {
  return (
    <div className={styles.group} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          className={styles.segment}
          type="button"
          aria-pressed={option.id === value}
          disabled={disabled ?? false}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

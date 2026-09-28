import type { JSX } from "react";
import type { SizeBreakdown } from "../lib/callGraph.js";
import styles from "./SizeBar.module.css";

const KINDS = ["core", "test", "boilerplate"] as const;
const LABEL = { core: "core", test: "tests", boilerplate: "boilerplate" } as const;
type Delta = { additions: number; deletions: number };
const weight = (d: Delta): number => d.additions + d.deletions;

/**
 * A PR's or slice's size as a bar proportioned by kind and the counts. Kinds
 * with no lines are left out; an unclassified set reads as one neutral
 * total; a set that changed nothing renders nothing.
 */
export function SizeBar({ size, className }: { size: SizeBreakdown; className?: string | undefined }): JSX.Element | null {
  const { byKind, total } = size;
  if (weight(total) === 0) return null;
  const parts = byKind
    ? KINDS.filter((k) => weight(byKind[k]) > 0).map((k) => ({ cls: k, label: LABEL[k], delta: byKind[k] }))
    : [{ cls: "unclassified" as const, label: null, delta: total }];
  return (
    <div className={`${styles.delta} ${className ?? ""}`}>
      <div className={styles.bar}>
        {parts.map((p) => (
          <span key={p.cls} className={`${styles.seg} ${styles[p.cls]}`} style={{ flex: weight(p.delta) }} />
        ))}
      </div>
      <div className={styles.text}>
        {parts.flatMap((p, i) => [
          // The separator is a sibling in the flex row, as the kinds are, so
          // the row's gap spaces it; inside a kind it would add its own.
          ...(i > 0 ? [<span key={`${p.cls}-sep`} className={styles.sep}>·</span>] : []),
          <span key={p.cls} className={styles[p.cls]}>
            {p.label && (
              <>
                <span className={styles.kind}>{p.label}</span>{" "}
              </>
            )}
            <span className={styles.plus}>+{p.delta.additions}</span>
            <span className={styles.minus}>−{p.delta.deletions}</span>
          </span>,
        ])}
      </div>
    </div>
  );
}

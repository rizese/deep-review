import type { JSX } from "react";
import { ExternalLink } from "lucide-react";
import type { MouseEvent } from "react";
import { Chrome } from "../components/Chrome.js";
import { SizeBar } from "../components/SizeBar.js";
import { addPr, forgetPr, parseKey, type PrView } from "../lib/api.js";
import { usePrs } from "../lib/usePrs.js";
import { useStored } from "../lib/useStored.js";
import styles from "./Index.module.css";


const KIND_LABEL = { transient: "network", config: "setup", input: "this PR", build: "build" } as const;

function humanDelay(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

function parkedNote(kind: keyof typeof KIND_LABEL): string {
  switch (kind) {
    case "config":
      return "not retried: fix the setup, then retry";
    case "input":
      return "not retried: nothing will change until the PR does";
    case "transient":
      return "gave up retrying; retry by hand, or it retries when the PR changes";
    default:
      return "parked until the PR changes; retry by hand to try again now";
  }
}

/** One line under a failed PR: what kind of failure, and what happens next. */
function failureNote(pr: PrView): string {
  const f = pr.failure;
  if (!f) return "";
  if (f.nextRetryAt !== undefined && !f.parked) {
    return `${KIND_LABEL[f.kind]} · retrying in ${humanDelay(f.nextRetryAt - Date.now())} (attempt ${f.attempts} so far)`;
  }
  return `${KIND_LABEL[f.kind]} · ${parkedNote(f.kind)}`;
}

function facts(pr: PrView): string {
  if (pr.state === "ready") return `${pr.slices ?? 0} slices · ${pr.graphs ?? 0} with a walkable call graph`;
  if (pr.state === "failed") return "";
  return "slicing and walking call graphs…";
}

function Card({ pr, hidden }: { pr: PrView; hidden: boolean }): JSX.Element {
  const last = pr.state === "building" ? (pr.log[pr.log.length - 1] ?? "") : "";
  const f = facts(pr);
  const open = (e: MouseEvent): void => {
    // Anywhere on a card opens its PR; its own links and buttons keep their meaning.
    if ((e.target as Element).closest("a, button, input, label")) return;
    if (e.metaKey || e.ctrlKey) window.open(pr.path, "_blank");
    else location.href = pr.path;
  };
  const retry = (): void => {
    const ref = parseKey(pr.key);
    if (ref) void addPr(ref);
  };
  const approvedTitle = pr.approvers.length ? `approved by ${pr.approvers.join(", ")}` : "approved";
  return (
    <div
      className={`${styles.row} ${pr.state === "failed" ? styles.failed : ""}`}
      data-key={pr.key}
      data-state={pr.state}
      data-role={pr.role}
      data-approved={pr.approved ? "true" : "false"}
      hidden={hidden}
      onClick={open}
    >
      <div>
        <div className={styles.name}>
          {pr.key}
          {pr.author ? ` · ${pr.author}` : ""}
        </div>
        <a className={styles.title} href={pr.path}>
          {pr.title ?? pr.key}
        </a>
        {f && <div className={styles.facts}>{f}</div>}
        {pr.state === "ready" && pr.size && <SizeBar size={pr.size} className={styles.size} />}
        {pr.error && (
          <div className={styles.why} data-why>
            {pr.error}
          </div>
        )}
        {pr.failure && <div className={styles.next}>{failureNote(pr)}</div>}
        {last && <div className={styles.last}>{last}</div>}
      </div>
      <div className={styles.side}>
        {pr.live && <span className={styles.dot} title="language services warm" />}
        {pr.draft && <span className={`${styles.pill} ${styles.draft}`}>draft</span>}
        {pr.approved && (
          <span className={`${styles.pill} ${styles.approved}`} title={approvedTitle}>
            approved
          </span>
        )}
        <span className={`${styles.pill} ${pr.state === "failed" ? styles.pillFailed : styles[pr.state]}`}>{pr.state}</span>
        {pr.state === "failed" && (
          <button className={styles.retry} type="button" title="Build this PR again now" onClick={retry}>
            retry
          </button>
        )}
        <a className={styles.gh} href={pr.prUrl} target="_blank" rel="noopener" title="Open on GitHub" aria-label="Open on GitHub">
          <ExternalLink aria-hidden="true" />
        </a>
        <button className={styles.forget} type="button" title="Drop this PR from the server" onClick={() => void forgetPr(pr.key)}>
          forget
        </button>
      </div>
    </div>
  );
}

/** The index: every PR the server holds, on two tabs, with approved ones hidden on request. */
export function Index(): JSX.Element {
  const { prs, ready } = usePrs();
  const [tabStored, setTab] = useStored("deep-review.tab", "review");
  const tab = tabStored === "authored" ? "authored" : "review";
  const [hideStored, setHide] = useStored("deep-review.hideApproved", "false");
  const hideApproved = hideStored === "true";

  const review = prs.filter((pr) => pr.role !== "authored");
  const authored = prs.filter((pr) => pr.role === "authored");
  // Every card is rendered and the off-tab or hidden-approved ones carry
  // `hidden`, so the list keeps its place in the DOM as tabs and the box
  // change and a PR stays the same element as its state moves.
  const onTab = tab === "authored" ? authored : review;
  const isShown = (pr: PrView): boolean => (pr.role === "authored") === (tab === "authored") && !(hideApproved && pr.approved);
  const shown = onTab.filter(isShown);
  const hidden = onTab.length - shown.length;

  return (
    <>
      <Chrome count={prs.length} />
      <main className={styles.page}>
        <div className={styles.toolbar}>
          <div className={styles.tabs} role="tablist">
            <button className={styles.tab} type="button" role="tab" aria-selected={tab === "review"} onClick={() => setTab("review")}>
              For review<span className={styles.tabCount}>{review.length || ""}</span>
            </button>
            <button className={styles.tab} type="button" role="tab" aria-selected={tab === "authored"} onClick={() => setTab("authored")}>
              My PRs<span className={styles.tabCount}>{authored.length || ""}</span>
            </button>
          </div>
          <label className={styles.toggle}>
            <input type="checkbox" checked={hideApproved} onChange={(e) => setHide(e.target.checked ? "true" : "false")} /> Hide approved PRs
          </label>
        </div>
        <div className={styles.rows}>
          {prs.map((pr) => (
            <Card key={pr.key} pr={pr} hidden={!isShown(pr)} />
          ))}
        </div>
        {ready && prs.length === 0 && (
          <div className={styles.empty}>
            Nothing loaded yet. Add a PR from any terminal:
            <div>
              <code>pr-review https://github.com/owner/repo/pull/123</code>
            </div>
          </div>
        )}
        {ready && prs.length > 0 && shown.length === 0 && tab === "review" && (
          <div className={styles.empty}>
            Nothing is waiting on your review.{" "}
            {hidden > 0 && <span>{`${hidden} approved PR${hidden === 1 ? " is" : "s are"} hidden.`}</span>}
          </div>
        )}
        {ready && prs.length > 0 && shown.length === 0 && tab === "authored" && (
          <div className={styles.empty}>
            None of your PRs are open here. {hidden > 0 && <span>{`${hidden} approved PR${hidden === 1 ? " is" : "s are"} hidden.`}</span>}
            <div>
              The watcher adds the PRs you open in each watched repo; <code>pr-review watch --repo owner/repo</code> names one.
            </div>
          </div>
        )}
      </main>
    </>
  );
}

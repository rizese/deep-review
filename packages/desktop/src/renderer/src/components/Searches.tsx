import { useCallback, useEffect, useState, type JSX } from "react";
import type { ElectronAPI, SearchPreview } from "../../../types/electronAPI.js";
import { Button } from "./Button.js";
import styles from "./Searches.module.css";

const BUILD_URL = "https://github.com/pulls";

type Tab = "review" | "authored";

interface Note {
  text: string;
  bad: boolean;
}

function reason(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" && error ? error : fallback;
}

/** One search's line, with what it finds shown beside it. */
function Row({
  query,
  api,
  onChange,
  onRemove,
}: {
  query: string;
  api: ElectronAPI;
  onChange: (next: string) => void;
  onRemove: () => void;
}): JSX.Element {
  const [preview, setPreview] = useState<SearchPreview | null>(null);
  const [why, setWhy] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const look = useCallback(async (): Promise<void> => {
    if (!query.trim()) return;
    setBusy(true);
    setWhy(null);
    try {
      const result = await api.watch.preview(query);
      if (result.success && result.data) setPreview(result.data);
      else {
        setPreview(null);
        setWhy(result.error ?? "GitHub would not answer that");
      }
    } catch (error) {
      setPreview(null);
      setWhy(reason(error, "GitHub would not answer that"));
    } finally {
      setBusy(false);
    }
  }, [api, query]);

  // What a search finds is the only way to judge it, so it is asked once
  // when the page opens and again whenever the line is left.
  useEffect(() => {
    void look();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const found = why ? "cannot run" : busy ? "…" : preview ? `${preview.count} PR${preview.count === 1 ? "" : "s"}` : "";
  return (
    <>
      <div className={styles.row}>
        <input
          className={styles.input}
          type="text"
          aria-label="Search"
          spellCheck={false}
          autoComplete="off"
          value={query}
          placeholder="is:open is:pr assignee:@me"
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => void look()}
        />
        <span className={styles.count} data-bad={why ? "true" : "false"} data-many={(preview?.count ?? 0) > 20 ? "true" : "false"} title={why ?? ""}>
          {found}
        </span>
        <Button size="sm" variant="danger" aria-label="Remove this search" onClick={onRemove}>
          remove
        </Button>
      </div>
      {why && <div className={styles.sample}>{why}</div>}
    </>
  );
}

/**
 * The searches behind the index's two tabs.
 *
 * There is no list of repos any more. GitHub already knows which PRs are
 * waiting on you, wherever they are, and the query that asks it — the one
 * in the address bar of github.com/pulls — is what this keeps. Paste that
 * page's URL and the query is taken out of it.
 */
export function Searches({ api }: { api: ElectronAPI }): JSX.Element {
  const [review, setReview] = useState<string[]>([]);
  const [authored, setAuthored] = useState<string[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const [fromDefaults, setFromDefaults] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);

  useEffect(() => {
    let alive = true;
    void api.watch
      .searches()
      .then((result) => {
        if (!alive) return;
        if (result.success && result.data) {
          setReview(result.data.review);
          setAuthored(result.data.authored);
          setProblems(result.data.problems);
          setFromDefaults(result.data.fromDefaults);
        } else setNote({ text: result.error ?? "could not read the searches", bad: true });
      })
      .catch((error: unknown) => {
        if (alive) setNote({ text: reason(error, "could not read the searches"), bad: true });
      })
      .finally(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [api]);

  const save = async (): Promise<void> => {
    setBusy(true);
    setNote(null);
    try {
      const result = await api.watch.setSearches({
        review: review.filter((q) => q.trim()),
        authored: authored.filter((q) => q.trim()),
      });
      if (result.success && result.data) {
        setReview(result.data.review);
        setAuthored(result.data.authored);
        setProblems(result.data.problems);
        setFromDefaults(result.data.fromDefaults);
        setNote({ text: "saved; checking GitHub now", bad: false });
      } else setNote({ text: result.error ?? "could not save", bad: true });
    } catch (error) {
      setNote({ text: reason(error, "could not save"), bad: true });
    } finally {
      setBusy(false);
    }
  };

  const lists: Record<Tab, { value: string[]; set: (next: string[]) => void; name: string; note: string }> = {
    review: { value: review, set: setReview, name: "For review", note: "what is waiting on you" },
    authored: { value: authored, set: setAuthored, name: "My PRs", note: "what you opened" },
  };

  return (
    <section className={styles.card} aria-label="Searches">
      <div className={styles.label}>What to show</div>
      <div className={styles.blurb}>
        Each tab is a GitHub search, the same one github.com/pulls runs. Paste that page's URL and the query is taken out of it.{" "}
        Several searches on a tab are merged, which is how &ldquo;assigned to me&rdquo; and &ldquo;review requested from me&rdquo; can both
        count. A search has to name somebody or somewhere: <code>assignee:@me</code>, <code>user:spara-ai</code>, <code>repo:owner/name</code>.
      </div>
      {(["review", "authored"] as Tab[]).map((tab) => {
        const list = lists[tab];
        return (
          <div className={styles.tab} key={tab}>
            <div className={styles.tabName}>
              {list.name}
              <span className={styles.tabNote}>{list.note}</span>
            </div>
            <div className={styles.rows}>
              {list.value.length === 0 && <div className={styles.none}>No search: this tab will be empty.</div>}
              {list.value.map((query, i) => (
                <Row
                  key={`${tab}-${i}`}
                  query={query}
                  api={api}
                  onChange={(next) => list.set(list.value.map((q, j) => (j === i ? next : q)))}
                  onRemove={() => list.set(list.value.filter((_, j) => j !== i))}
                />
              ))}
            </div>
            <div className={styles.actions}>
              <Button size="sm" onClick={() => list.set([...list.value, ""])}>
                Add a search
              </Button>
            </div>
          </div>
        );
      })}
      <div className={styles.actions}>
        <Button variant="primary" disabled={busy || !loaded} onClick={() => void save()}>
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button size="sm" onClick={() => void api.app.openExternal(BUILD_URL)}>
          Build one on GitHub
        </Button>
        {fromDefaults && <span className={styles.note}>these are the defaults</span>}
        {note && (
          <span className={styles.note} data-bad={note.bad ? "true" : "false"}>
            {note.text}
          </span>
        )}
      </div>
      {problems.length > 0 && (
        <div className={styles.problems}>
          {problems.map((problem) => (
            <div key={problem}>{problem}</div>
          ))}
        </div>
      )}
    </section>
  );
}

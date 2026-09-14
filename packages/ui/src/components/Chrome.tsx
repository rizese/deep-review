import type { JSX } from "react";
import { useState, type FormEvent } from "react";
import wordmark from "../assets/wordmark.png";
import { addPr, parsePrUrl } from "../lib/api.js";
import { useTheme, type Theme } from "../lib/theme.js";
import styles from "./Chrome.module.css";

const THEMES: { id: Theme; glyph: string; title: string }[] = [
  { id: "light", glyph: "☀", title: "Light" },
  { id: "system", glyph: "◐", title: "Follow the system" },
  { id: "dark", glyph: "☾", title: "Dark" },
];

/**
 * The bar along the top of every page: the wordmark as the way home, how
 * many PRs the server holds with a way to add one by URL, and the theme.
 */
export function Chrome({ count }: { count: number }): JSX.Element {
  const [theme, setTheme] = useTheme();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const ref = parsePrUrl(url);
    if (!ref) {
      setNote({ text: "not a PR URL", bad: true });
      return;
    }
    setNote({ text: "adding…", bad: false });
    try {
      const pr = await addPr(ref);
      location.href = pr.path;
    } catch (error) {
      setNote({ text: error instanceof Error ? error.message : "the server is not answering", bad: true });
    }
  };

  return (
    <nav className={styles.chrome} aria-label="Deep Review">
      <a className={`${styles.glass} ${styles.brand}`} href="/" title="Every PR on this server">
        <span
          className={styles.wordmark}
          role="img"
          aria-label="Deep Review"
          style={{ ["--wordmark-mask" as string]: `url(${wordmark})` }}
        />
      </a>
      <div className={`${styles.glass} ${styles.tools}`}>
        <span className={styles.count} title="PRs on this server">
          {count}
        </span>
        <button
          className={styles.add}
          type="button"
          title="Add a PR by URL"
          aria-label="Add a PR by URL"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
            setNote(null);
          }}
        >
          {open ? (
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 2.5v11M2.5 8h11" />
            </svg>
          )}
        </button>
        {open && (
          <form className={styles.addForm} aria-label="Add a PR by URL" onSubmit={(e) => void submit(e)}>
            <input
              type="url"
              name="url"
              placeholder="https://github.com/owner/repo/pull/123"
              aria-label="PR URL"
              required
              autoFocus
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            {note && <span className={`${styles.note} ${note.bad ? styles.bad : ""}`}>{note.text}</span>}
          </form>
        )}
      </div>
      <div className={`${styles.glass} ${styles.theme}`} role="group" aria-label="Theme">
        {THEMES.map((t) => (
          <button key={t.id} type="button" title={t.title} aria-pressed={theme === t.id} onClick={() => setTheme(t.id)}>
            {t.glyph}
          </button>
        ))}
      </div>
    </nav>
  );
}

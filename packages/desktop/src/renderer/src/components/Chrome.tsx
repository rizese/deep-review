import type { JSX } from "react";
import { Contrast, Moon, Plus, Sun, Wrench, X, type LucideIcon } from "lucide-react";
import { useState, type FormEvent } from "react";
import wordmark from "../assets/wordmark.png";
import { addPr, parsePrUrl } from "../lib/api.js";
import { go } from "../lib/route.js";
import { useTheme, type Theme } from "../lib/theme.js";
import styles from "./Chrome.module.css";

const THEMES: { id: Theme; Icon: LucideIcon; title: string }[] = [
  { id: "light", Icon: Sun, title: "Light" },
  { id: "system", Icon: Contrast, title: "Follow the system" },
  { id: "dark", Icon: Moon, title: "Dark" },
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
      go(pr.path);
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
        <a className={styles.count} href="/" title="Every PR on this server">
          {count}
        </a>
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
          {open ? <X aria-hidden="true" /> : <Plus aria-hidden="true" />}
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
      {/* Only the desktop app has settings to reach; in a browser the bar is
          exactly what it was. */}
      {typeof window !== "undefined" && window.electronAPI && (
        <div className={`${styles.glass} ${styles.settings}`}>
          <button
            className={styles.gear}
            type="button"
            title="Settings"
            aria-label="Settings"
            onClick={() => go("/settings")}
          >
            <Wrench aria-hidden="true" />
          </button>
        </div>
      )}
      <div className={`${styles.glass} ${styles.theme}`} role="group" aria-label="Theme">
        {THEMES.map((t) => (
          <button key={t.id} type="button" title={t.title} aria-label={t.title} aria-pressed={theme === t.id} onClick={() => setTheme(t.id)}>
            <t.Icon aria-hidden="true" />
          </button>
        ))}
      </div>
    </nav>
  );
}

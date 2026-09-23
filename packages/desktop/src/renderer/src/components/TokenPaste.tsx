import { useState, type FormEvent, type JSX } from "react";
import { Button } from "./Button.js";
import { CopyButton } from "./CopyButton.js";
import styles from "./TokenPaste.module.css";

const COMMAND = "gh auth token";

/**
 * The other way in: paste a token you already have.
 *
 * The app used to run `gh auth token` itself. Printing the command and
 * taking what comes back is the same thing with nothing to go wrong — no
 * PATH to find, no CLI to have installed, no shell to spawn — and it
 * takes a token from anywhere else just as happily.
 */
export function TokenPaste({
  onSubmit,
  onBack,
  busy,
  inCard,
}: {
  onSubmit: (token: string) => Promise<boolean>;
  onBack: () => void;
  busy: boolean;
  inCard?: boolean;
}): JSX.Element {
  const [token, setToken] = useState("");

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    // Cleared only once GitHub has taken it, so a rejected paste is still
    // there to look at.
    if (await onSubmit(token)) setToken("");
  };

  return (
    <div className={`${styles.paste} ${inCard ? styles.inCard : ""}`}>
      <p className={styles.how}>
        Run{" "}
        <span className={styles.cmd}>
          {COMMAND}
          <CopyButton text={COMMAND} label="Copy the command" className={styles.copy} />
        </span>{" "}
        in a terminal and paste what it prints.
      </p>
      <form
        className={styles.form}
        aria-label="Paste a token"
        onSubmit={(e) => void submit(e)}
      >
        <input
          className={styles.input}
          type="password"
          aria-label="GitHub token"
          placeholder="gho_......"
          autoComplete="off"
          spellCheck={false}
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <Button type="submit" disabled={busy || !token.trim()}>
          Sign in
        </Button>
      </form>
      <Button size="sm" onClick={onBack}>
        Back
      </Button>
    </div>
  );
}

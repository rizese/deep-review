import { SiGithub } from "@icons-pack/react-simple-icons";
import type { JSX } from "react";
import { useGithubAuth } from "../lib/useGithubAuth.js";
import { SignInWays } from "./SignInWays.js";
import styles from "./SignInScreen.module.css";

/**
 * What the index is before there is a token: not an empty list with a
 * banner over it, but the one thing there is to do, in the middle of the
 * window. Signing in happens here — the button starts the device flow
 * rather than sending anyone to a settings page to find it.
 */
export function SignInScreen(): JSX.Element {
  const auth = useGithubAuth();

  return (
    <main className={styles.screen} aria-label="Sign in">
      <span className={styles.mark} aria-hidden="true">
        <SiGithub />
      </span>
      <h1 className={styles.title}>Sign in to GitHub</h1>
      <SignInWays
        auth={auth}
        wide
        rowClassName={styles.ways}
        after={
          <p className={styles.scopes}>
            Asks for <code>repo</code> and <code>read:org</code>, and keeps the
            token encrypted by the OS keychain.
          </p>
        }
      />
      {auth.note && (
        <div
          className={styles.note}
          data-bad={auth.note.bad ? "true" : "false"}
        >
          {auth.note.text}
        </div>
      )}
    </main>
  );
}

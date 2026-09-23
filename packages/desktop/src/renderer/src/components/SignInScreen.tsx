import { SiGithub } from "@icons-pack/react-simple-icons";
import type { JSX } from "react";
import { useGithubAuth } from "../lib/useGithubAuth.js";
import { FirstRun } from "./FirstRun.js";
import { SignInWays } from "./SignInWays.js";
import styles from "./SignInScreen.module.css";

/**
 * The first step of getting started: an account to read PRs from. Signing
 * in happens here — the button starts the device flow rather than sending
 * anyone to a settings page to find it.
 */
export function SignInScreen(): JSX.Element {
  const auth = useGithubAuth();

  return (
    <FirstRun label="Sign in" mark={<SiGithub />} title="Sign in to GitHub" note={auth.note}>
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
    </FirstRun>
  );
}

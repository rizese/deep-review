import { SiGithub } from "@icons-pack/react-simple-icons";
import { useState, type JSX, type ReactNode } from "react";
import type { GithubAuth } from "../lib/useGithubAuth.js";
import { Button } from "./Button.js";
import { DeviceCode } from "./DeviceCode.js";
import { TokenPaste } from "./TokenPaste.js";

/**
 * The ways in, wherever they are offered: the first-run screen and the
 * settings card show the same two and must not drift apart.
 *
 * Signing in with GitHub is one step — the code appears where you stand.
 * The CLI token is two, because the token has to be fetched in a terminal
 * first; asking for it only once that way has been chosen keeps the
 * choice itself down to two buttons.
 *
 * Layout stays with the caller: it passes the class for the row of buttons
 * (stacked on the screen, side by side on the card) and whatever sits with
 * the choice, which then leaves when the choice does.
 */
export function SignInWays({
  auth,
  wide,
  rowClassName,
  before,
  after,
}: {
  auth: GithubAuth;
  /** The roomier treatment, for a whole page rather than a card. */
  wide?: boolean;
  rowClassName?: string | undefined;
  before?: ReactNode;
  after?: ReactNode;
}): JSX.Element {
  const [pasting, setPasting] = useState(false);

  if (auth.device) return <DeviceCode prompt={auth.device} wide={wide} onCancel={() => void auth.cancel()} />;
  if (pasting) {
    return <TokenPaste onSubmit={auth.signInWithToken} onBack={() => setPasting(false)} busy={auth.busy} inCard={!wide} />;
  }
  return (
    <>
      {before}
      <div className={rowClassName ?? ""}>
        <Button disabled={auth.busy || !auth.loaded} onClick={() => void auth.signIn()}>
          <SiGithub aria-hidden="true" />
          Sign in with GitHub
        </Button>
        <Button disabled={auth.busy} onClick={() => setPasting(true)} title="Paste the token the GitHub CLI is signed in with">
          <SiGithub aria-hidden="true" />
          Use the GitHub CLI token
        </Button>
      </div>
      {after}
    </>
  );
}

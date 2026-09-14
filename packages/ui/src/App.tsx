import type { JSX } from "react";
import { Index } from "./pages/Index.js";

/**
 * Which page this is, from the address. The index lives at `/`; a PR's page
 * is served by the daemon until it moves here too.
 */
export function App(): JSX.Element {
  return <Index />;
}

import { useMemo, type JSX } from "react";
import { usePanelScroll } from "./panelScroll.js";

/**
 * A panel for a definition the call graph did not reach, rendered by the
 * navigation server and arriving as HTML. The card itself is this
 * component's; what is inside it is the server's own `renderDefinitionPanel`
 * output, so it reads exactly as a panel the page built.
 */
export function DefPanel({ id, html }: { id: string; html: string }): JSX.Element {
  const ref = usePanelScroll(id);
  const inner = useMemo(() => {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return doc.querySelector("article.panel")?.innerHTML ?? html;
  }, [html]);
  return <article className="panel" data-node={id} ref={ref} dangerouslySetInnerHTML={{ __html: inner }} />;
}

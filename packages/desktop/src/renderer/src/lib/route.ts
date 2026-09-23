/**
 * Moving between pages without a document load. The app is one page: the
 * pool behind it never repaints, the bar stays where it is, and the content
 * fades out and back in (PageFade). `go` changes the address and tells the
 * listeners; `interceptLinks` makes every in-app `<a href="/…">` do the
 * same, so a link is still a link — copyable, middle-clickable — but a
 * plain click stays inside the app.
 */
export function go(path: string): void {
  if (location.pathname === path) return;
  history.pushState({}, "", path);
  dispatchEvent(new PopStateEvent("popstate"));
}

/** Same-app links navigate in place; anything external, modified or targeted is left alone. */
export function interceptLinks(): () => void {
  const onClick = (e: MouseEvent): void => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const anchor = (e.target as Element | null)?.closest("a[href]");
    if (!anchor) return;
    const href = anchor.getAttribute("href") ?? "";
    if (anchor.getAttribute("target") === "_blank" || !href.startsWith("/") || href.startsWith("//")) return;
    e.preventDefault();
    go(href);
  };
  document.addEventListener("click", onClick);
  return () => document.removeEventListener("click", onClick);
}

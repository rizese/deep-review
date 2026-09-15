/**
 * Moving between the pages this app renders itself, without asking the
 * server for a document. The index and a PR are addresses the server
 * mounts, so a link is enough for those; `/settings` is the app's own page
 * and the server knows nothing about it, so going there is a pushState and
 * the popstate every listener already watches.
 */
export function go(path: string): void {
  if (location.pathname === path) return;
  history.pushState({}, "", path);
  dispatchEvent(new PopStateEvent("popstate"));
}

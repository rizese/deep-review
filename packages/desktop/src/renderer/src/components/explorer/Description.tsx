import { useMemo, type JSX } from "react";
import { renderMarkdown, type SliceExplorerInput } from "../../lib/callGraph.js";

/**
 * The PR as its author wrote it, plus the slicing model's own read of it —
 * the one view of the page that is not code. A port of
 * `renderDescriptionView`; the Markdown is the analysis package's own
 * renderer, so a description reads identically to the server's page.
 */
export function Description({ input }: { input: SliceExplorerInput }): JSX.Element {
  const description = (input.prDescription ?? "").trim();
  const body = useMemo(
    () => (description ? renderMarkdown(description, { baseUrl: input.prUrl }) : null),
    [description, input.prUrl],
  );
  return (
    <section className="doc-view">
      <span className="eyebrow">Pull request</span>
      <h3 className="doc-title">{input.prTitle}</h3>
      <div className="doc-meta">
        <a href={input.prUrl}>
          {input.repo}#{input.number}
        </a>
        {input.prAuthor ? ` · opened by ${input.prAuthor}` : ""}
      </div>
      {/* The rendered Markdown sits directly in the block, as it does on the
          server's page: `.doc-block > :last-child` trims the last element's
          margin, and a wrapper of our own would take that trim instead. */}
      <div
        className="doc-block"
        dangerouslySetInnerHTML={{
          __html: `<div class="side-label">Description</div>${body ?? '<p class="doc-empty">This PR has no description.</p>'}`,
        }}
      />
      <div className="doc-block">
        <div className="side-label">Overview · what the slicer read</div>
        <p className="doc-overview">{input.overview}</p>
      </div>
    </section>
  );
}

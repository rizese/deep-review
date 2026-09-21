import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState, type JSX, type Ref } from "react";
import { toClipboard } from "../lib/clipboard.js";

/**
 * Put one short string on the clipboard, and say for a moment that it
 * worked. The icon is the whole control; the label carries the meaning
 * for anyone not looking at it.
 */
export function CopyButton({
  text,
  label,
  className,
  ref,
}: {
  text: string;
  label: string;
  className?: string | undefined;
  /** So a larger click target can stand in for this one and share its feedback. */
  ref?: Ref<HTMLButtonElement> | undefined;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = async (): Promise<void> => {
    if (!(await toClipboard(text))) return;
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      ref={ref}
      className={className ?? ""}
      type="button"
      aria-label={copied ? "Copied" : label}
      data-copied={copied ? "true" : "false"}
      onClick={() => void copy()}
    >
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
    </button>
  );
}

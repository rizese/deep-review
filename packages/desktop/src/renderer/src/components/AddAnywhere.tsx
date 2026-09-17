import { useEffect, useRef, useState, type JSX } from "react";
import { addAndOpen, findPrUrl, keyOf, mentionsGithub } from "../lib/addByUrl.js";
import styles from "./AddAnywhere.module.css";

interface Toast {
  text: string;
  bad: boolean;
}

/** Whether a paste here was aimed at a field of its own rather than the page. */
function inField(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : null;
  return Boolean(el?.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']"));
}

/** A drag that carries text or a link, as opposed to files from the Finder. */
function carriesLink(transfer: DataTransfer | null): boolean {
  if (!transfer) return false;
  const types = Array.from(transfer.types);
  return types.includes("text/uri-list") || types.includes("text/plain");
}

/**
 * Any PR link that reaches the window — dropped from a browser tab, pasted
 * with ⌘V while nothing has focus — is added and opened, the same as typing
 * it into the bar. Mounted once, beside the pages; it draws nothing until
 * it has something to say.
 */
export function AddAnywhere(): JSX.Element {
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const depth = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const say = (next: Toast, forMs = 4500): void => {
    if (timer.current) clearTimeout(timer.current);
    setToast(next);
    timer.current = setTimeout(() => setToast(null), forMs);
  };

  const take = async (text: string, from: "drop" | "paste"): Promise<void> => {
    const ref = findPrUrl(text);
    if (!ref) {
      // A random paste is none of our business; something GitHub-shaped that
      // is not a PR deserves a word.
      if (from === "drop" || mentionsGithub(text)) say({ text: "that is not a link to a pull request", bad: true });
      return;
    }
    say({ text: `adding ${keyOf(ref)}…`, bad: false }, 60_000);
    const outcome = await addAndOpen(ref);
    if (outcome.ok) setToast(null);
    else say({ text: outcome.why, bad: true }, 6000);
  };

  useEffect(() => {
    const onEnter = (e: DragEvent): void => {
      if (!carriesLink(e.dataTransfer)) return;
      e.preventDefault();
      depth.current += 1;
      setDragging(true);
    };
    const onOver = (e: DragEvent): void => {
      if (!carriesLink(e.dataTransfer)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onLeave = (e: DragEvent): void => {
      if (!carriesLink(e.dataTransfer)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent): void => {
      depth.current = 0;
      setDragging(false);
      if (!carriesLink(e.dataTransfer)) return;
      // Left alone, a dropped link would load in place of the app.
      e.preventDefault();
      const text = e.dataTransfer?.getData("text/uri-list") || e.dataTransfer?.getData("text/plain") || "";
      void take(text, "drop");
    };
    const onPaste = (e: ClipboardEvent): void => {
      if (inField(e.target)) return;
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (!text) return;
      void take(text, "paste");
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    document.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
      document.removeEventListener("paste", onPaste);
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  return (
    <>
      <div className={styles.drop} data-active={dragging ? "true" : "false"} aria-hidden="true">
        {dragging && <span className={styles.dropLabel}>Drop to add the PR</span>}
      </div>
      {toast && (
        <div className={styles.toast} role="status" data-bad={toast.bad ? "true" : "false"}>
          {toast.text}
        </div>
      )}
    </>
  );
}

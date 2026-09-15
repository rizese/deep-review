/**
 * A stand-in for buildWorker.ts under test: answers a build request with
 * progress lines and either a tiny build, a typed error, or a crash,
 * depending on the PR URL it is asked about.
 */
import process from "node:process";
import { ConfigError } from "@deep-review/pr";
import { serializeError, type ParentToWorker, type WorkerToParent } from "../buildFork.js";

const send = (message: WorkerToParent): void => void process.send?.(message);

process.once("message", (raw: unknown) => {
  const msg = raw as ParentToWorker;
  if (msg.type !== "build") return;
  const { prUrl, navBase } = msg.request;
  send({ type: "log", message: "first" });
  send({ type: "log", message: "second" });
  if (prUrl.includes("/crash/")) process.exit(3);
  const lastWord = (message: WorkerToParent, code: number): void =>
    void process.send?.(message, undefined, undefined, () => process.exit(code));
  if (prUrl.includes("/fail/")) {
    lastWord(serializeError(new ConfigError("no token for you")), 1);
    return;
  }
  // A real build's input is megabytes; a worker that exits before the pipe
  // drains loses it, so the fake can be asked for one that size.
  const overview = prUrl.includes("/big/") ? "x".repeat(6 * 1024 * 1024) : navBase;
  lastWord(
    {
      type: "done",
      built: {
        input: { prUrl, prTitle: "fake", repo: "a/b", number: 1, overview, files: [], slices: [], navBase },
        headDir: "/tmp/nowhere",
        headSha: "h",
        baseSha: "b",
      },
    },
    0,
  );
});

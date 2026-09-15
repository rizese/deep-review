/**
 * The child side of buildFork.ts: wait for one build request, run it,
 * report progress and the result over IPC, and exit. One build per
 * process, so a language service's memory and any leaked handle go with it.
 */

import process from "node:process";
import type { ParentToWorker, WorkerToParent } from "./buildFork.js";
import { serializeError } from "./buildFork.js";
import { runBuild } from "./buildJob.js";

const send = (message: WorkerToParent): void => {
  process.send?.(message);
};

/**
 * The last word, then exit — but only once the message has actually left.
 * `process.send` queues; a page is megabytes; an exit (or disconnect) right
 * after it cut the message off and the parent saw only "exited with code
 * 0". The callback fires when the write is done.
 */
const sendLastAndExit = (message: WorkerToParent, code: number): void => {
  if (!process.send) {
    process.exit(code);
  }
  process.send(message, undefined, undefined, () => process.exit(code));
};

process.once("message", (raw: unknown) => {
  const msg = raw as ParentToWorker;
  if (msg.type !== "build") return;
  runBuild(msg.request, (message) => send({ type: "log", message }))
    .then((built) => sendLastAndExit({ type: "done", built }, 0))
    .catch((error: unknown) => sendLastAndExit(serializeError(error), 1));
});

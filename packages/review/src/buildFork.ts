/**
 * A build in a child process. The server forks `buildWorker.ts`, sends it
 * the request, relays its progress lines, and takes back either the built
 * page or an error with its kind intact — so the server's own event loop
 * never blocks on a clone or a language service, and a build that crashes
 * takes down one child, not the server and every other PR it holds.
 *
 * The child is this same CLI's source, run with this process's own loader
 * flags (tsx in development; plain node against dist in a build), the way
 * `ensureServer` re-runs the CLI as `serve`.
 */

import { fork, type ChildProcess } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  BuildError,
  ConfigError,
  describeError,
  failureKindOf,
  InputError,
  TransientError,
  type FailureKind,
} from "@deep-review/pr";
import type { BuildPr, BuiltPr } from "./registry.js";

/** What a build request looks like on the wire; the same shape `BuildPr` takes. */
export type BuildRequest = Parameters<BuildPr>[0];

export type WorkerToParent =
  | { type: "log"; message: string }
  | { type: "done"; built: BuiltPr }
  | { type: "error"; kind: FailureKind; message: string; stack?: string | undefined };

export type ParentToWorker = { type: "build"; request: BuildRequest };

/** Wire form of an error, for the child to send. */
export function serializeError(error: unknown): WorkerToParent {
  return {
    type: "error",
    kind: failureKindOf(error),
    message: describeError(error),
    stack: error instanceof Error ? error.stack : undefined,
  };
}

/** The error back as one of ours, so the parent can classify it exactly as the child did. */
export function errorOfKind(kind: FailureKind, message: string): Error {
  switch (kind) {
    case "transient":
      return new TransientError(message);
    case "config":
      return new ConfigError(message);
    case "input":
      return new InputError(message);
    default:
      return new BuildError(message);
  }
}

/** The worker beside this file, in whatever form this file is running as (.ts under tsx, .js from dist). */
function defaultWorkerPath(): string {
  const here = fileURLToPath(import.meta.url);
  return here.replace(/buildFork\.(ts|js)$/, "buildWorker.$1");
}

/** Loader flags for a child that must run the same kind of file this one is. */
function execArgvFor(workerPath: string): string[] {
  const argv = [...process.execArgv];
  if (workerPath.endsWith(".ts") && !argv.some((a) => a.includes("tsx"))) argv.push("--import", "tsx");
  return argv;
}

export interface ForkBuildOptions {
  /** Another worker script — for tests, or for a host that bundled this code somewhere else. */
  workerPath?: string | undefined;
  /** Extra environment for the child; Electron hosts set ELECTRON_RUN_AS_NODE here. */
  env?: NodeJS.ProcessEnv | undefined;
}

/**
 * A `BuildPr` that runs each build in its own child process. The child gets
 * the request over IPC and answers with progress and then a result; a child
 * that dies without answering is reported as a build failure naming the
 * exit code or signal.
 */
export function forkBuild(options: ForkBuildOptions = {}): BuildPr {
  const workerPath = options.workerPath ?? defaultWorkerPath();
  return (request, log) =>
    new Promise<BuiltPr>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = fork(workerPath, [], {
          execArgv: execArgvFor(workerPath),
          env: { ...process.env, ...options.env },
          stdio: ["ignore", "inherit", "inherit", "ipc"],
          // IPC carries a multi-megabyte page in one message; the default
          // serializer is fine for it, advanced would be slower.
          serialization: "json",
        });
      } catch (error) {
        reject(new BuildError(`could not start a build worker: ${describeError(error)}`, { cause: error }));
        return;
      }
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        fn();
      };
      child.on("message", (raw: unknown) => {
        const msg = raw as WorkerToParent;
        if (msg.type === "log") log(msg.message);
        else if (msg.type === "done") finish(() => resolve(msg.built));
        else if (msg.type === "error") finish(() => reject(errorOfKind(msg.kind, msg.message)));
      });
      child.on("error", (error) => finish(() => reject(new BuildError(`build worker failed: ${describeError(error)}`, { cause: error }))));
      child.on("exit", (code, signal) => {
        finish(() =>
          reject(
            new BuildError(
              `the build worker exited before finishing (${signal ? `signal ${signal}` : `code ${code}`})`,
            ),
          ),
        );
      });
      const message: ParentToWorker = { type: "build", request };
      child.send(message);
    });
}

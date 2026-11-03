import { WorkerPoolContextProvider } from "@pierre/diffs/react";
import type { ReactNode } from "react";
import { highlighterOptions } from "./pierre-options";

const poolOptions = {
  poolSize: Math.min(3, Math.max(1, navigator.hardwareConcurrency || 3)),
  workerFactory: () => new Worker(new URL("@pierre/diffs/worker/worker.js", import.meta.url), { type: "module" }),
};

/** Mount once at the app root so every Pierre renderer shares a single worker pool. */
export function DiffWorkerPoolProvider({ children }: { children: ReactNode }) {
  return (
    <WorkerPoolContextProvider poolOptions={poolOptions} highlighterOptions={highlighterOptions}>
      {children}
    </WorkerPoolContextProvider>
  );
}

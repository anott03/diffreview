import { Toasty } from "@cloudflare/kumo";
import { WorkerPoolContextProvider } from "@pierre/diffs/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { highlighterOptions } from "./components/pierre-options";
import "./styles.css";

const poolOptions = {
  poolSize: Math.min(3, Math.max(1, navigator.hardwareConcurrency || 3)),
  workerFactory: () => new Worker(new URL("@pierre/diffs/worker/worker.js", import.meta.url), { type: "module" }),
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WorkerPoolContextProvider poolOptions={poolOptions} highlighterOptions={highlighterOptions}>
      <Toasty>
        <App />
      </Toasty>
    </WorkerPoolContextProvider>
  </StrictMode>,
);

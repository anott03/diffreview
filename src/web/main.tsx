import { Toasty } from "@cloudflare/kumo";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DiffWorkerPoolProvider } from "../ui/DiffWorkerPoolProvider";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DiffWorkerPoolProvider>
      <Toasty>
        <App />
      </Toasty>
    </DiffWorkerPoolProvider>
  </StrictMode>,
);

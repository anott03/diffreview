import { useSyncExternalStore } from "react";

export type ColorMode = "light" | "dark";

function readMode(): ColorMode {
  return document.documentElement.dataset.mode === "light" ? "light" : "dark";
}

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode"] });
  return () => observer.disconnect();
}

export function useColorMode(): ColorMode {
  return useSyncExternalStore(subscribe, readMode, () => "dark");
}

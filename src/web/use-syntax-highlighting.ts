import { useEffect, useState } from "react";
import { syntaxLanguage, type SyntaxLines, type SyntaxRequest, type SyntaxResponse, type SyntaxSource } from "./syntax-highlighting";

const MAX_ATTEMPTS = 2;

let worker: Worker | undefined;
let nextId = 0;
type PendingEntry = {
  resolve: (response: SyntaxResponse) => void;
  request: SyntaxRequest;
  attempts: number;
};
const pending = new Map<number, PendingEntry>();
const emptyLines: SyntaxLines = new Map();

function syntaxWorker(): Worker {
  if (worker) return worker;
  const instance = new Worker(new URL("./syntax-worker.ts", import.meta.url), { type: "module" });
  instance.onmessage = (event: MessageEvent<SyntaxResponse>) => {
    if (worker !== instance) return;
    pending.get(event.data.id)?.resolve(event.data);
    pending.delete(event.data.id);
  };
  instance.onerror = () => {
    if (worker !== instance) return;
    instance.terminate();
    worker = undefined;
    for (const [id, entry] of pending) {
      if (entry.attempts >= MAX_ATTEMPTS) {
        pending.delete(id);
        continue;
      }
      entry.attempts++;
      try {
        syntaxWorker().postMessage(entry.request);
      } catch {
        pending.delete(id);
      }
    }
  };
  worker = instance;
  return instance;
}

export function useSyntaxHighlighting(sources: SyntaxSource[], enabled = true): SyntaxLines {
  const [result, setResult] = useState<{ sources: SyntaxSource[]; lines: SyntaxLines } | null>(null);

  useEffect(() => {
    if (!enabled || result?.sources === sources || !sources.some((source) => syntaxLanguage(source.path))) return;
    const request: SyntaxRequest = { id: nextId++, sources };
    try {
      const instance = syntaxWorker();
      pending.set(request.id, {
        resolve: (response) => {
          const lines: SyntaxLines = new Map();
          response.tokens.forEach((block, index) => {
            const source = sources[index];
            if (!source || !block) return;
            block.forEach((tokens, offset) => lines.set(`${source.side}:${source.startLine + offset}`, tokens));
          });
          setResult({ sources, lines });
        },
        request,
        attempts: 1,
      });
      instance.postMessage(request);
    } catch {
      pending.delete(request.id);
    }
    return () => { pending.delete(request.id); };
  }, [sources, enabled, result]);

  return result?.sources === sources ? result.lines : emptyLines;
}

import { useEffect, useState } from "react";
import { syntaxLanguage, type SyntaxLines, type SyntaxRequest, type SyntaxResponse, type SyntaxSource } from "./syntax-highlighting";

let worker: Worker | undefined;
let nextId = 0;
const pending = new Map<number, (response: SyntaxResponse) => void>();
const emptyLines: SyntaxLines = new Map();

function syntaxWorker(): Worker {
  if (worker) return worker;
  const instance = new Worker(new URL("./syntax-worker.ts", import.meta.url), { type: "module" });
  instance.onmessage = (event: MessageEvent<SyntaxResponse>) => {
    pending.get(event.data.id)?.(event.data);
    pending.delete(event.data.id);
  };
  instance.onerror = () => {
    for (const [id, resolve] of pending) resolve({ id, tokens: [] });
    pending.clear();
    instance.terminate();
    worker = undefined;
  };
  worker = instance;
  return instance;
}

export function useSyntaxHighlighting(sources: SyntaxSource[], enabled = true): SyntaxLines {
  const [result, setResult] = useState<{ sources: SyntaxSource[]; lines: SyntaxLines } | null>(null);

  useEffect(() => {
    if (!enabled || result?.sources === sources || !sources.some((source) => syntaxLanguage(source.path))) return;
    const id = nextId++;
    try {
      const instance = syntaxWorker();
      pending.set(id, (response) => {
        const lines: SyntaxLines = new Map();
        response.tokens.forEach((block, index) => {
          const source = sources[index];
          if (!source || !block) return;
          block.forEach((tokens, offset) => lines.set(`${source.side}:${source.startLine + offset}`, tokens));
        });
        setResult({ sources, lines });
      });
      instance.postMessage({ id, sources } satisfies SyntaxRequest);
    } catch {
      pending.delete(id);
    }
    return () => { pending.delete(id); };
  }, [sources, enabled, result]);

  return result?.sources === sources ? result.lines : emptyLines;
}

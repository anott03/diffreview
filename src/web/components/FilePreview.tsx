import { Button } from "@cloudflare/kumo/components/button";
import { Loader } from "@cloudflare/kumo/components/loader";
import { useEffect, useState } from "react";
import type { Comment, FileContent } from "../../shared/types";
import { CommentThread } from "./CommentThread";

interface FilePreviewProps {
  path: string;
  active: boolean;
  revision: number;
  connectionVersion: number;
  loadFile: (path: string, signal?: AbortSignal) => Promise<FileContent>;
  comments: Comment[];
  onCarryForward: (id: string) => void;
  onResolve: (id: string) => void;
  onReopen: (id: string) => void;
  onDelete: (id: string) => void;
}

const PREVIEW_MESSAGES = {
  binary: "Binary file. No text preview available.",
  "too-large": "This file is larger than the 1 MiB preview limit.",
  unsupported: "This file type cannot be previewed.",
};

export function FilePreview({ path, active, revision, connectionVersion, loadFile, comments, onCarryForward, onResolve, onReopen, onDelete }: FilePreviewProps) {
  const [file, setFile] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setError(null);
    void loadFile(path, controller.signal).then((result) => {
      if (!controller.signal.aborted) setFile(result);
    }).catch((cause) => {
      if (!controller.signal.aborted) setError(String(cause));
    });
    return () => controller.abort();
  }, [path, active, revision, connectionVersion, loadFile, retry]);

  const lines = file?.kind === "text" && file.content ? file.content.split("\n") : [];
  if (file?.content?.endsWith("\n")) lines.pop();

  return (
    <main className="min-w-0 flex-1 overflow-auto">
      <div className="sticky top-0 z-10 flex min-h-10 items-center gap-3 border-b border-kumo-line bg-kumo-elevated px-4 py-2">
        <h2 className="min-w-0 flex-1 break-all font-mono text-sm">{path}</h2>
        <span className="shrink-0 text-sm text-kumo-subtle">Read-only</span>
      </div>
      {comments.length > 0 && (
        <section aria-label="File comments" className="flex flex-col gap-px border-b border-kumo-line">
          {comments.map((comment) => (
            <CommentThread
              key={comment.id}
              comment={comment}
              showContext
              onCarryForward={onCarryForward}
              onResolve={onResolve}
              onReopen={onReopen}
              onDelete={onDelete}
            />
          ))}
        </section>
      )}
      {error ? (
        <div role="alert" className="space-y-3 px-4 py-6 text-sm">
          <p className="break-words">Could not load this file. {error}</p>
          <Button variant="secondary" size="sm" onClick={() => setRetry((value) => value + 1)}>Retry</Button>
        </div>
      ) : !file ? (
        <div role="status" className="flex items-center gap-2 px-4 py-6 text-sm"><Loader />Loading file…</div>
      ) : file.kind === "symlink" ? (
        <p className="px-4 py-6 text-sm">Symbolic link to <code className="break-all">{file.content}</code></p>
      ) : file.kind !== "text" ? (
        <p className="px-4 py-6 text-sm text-kumo-subtle">{PREVIEW_MESSAGES[file.kind]}</p>
      ) : lines.length === 0 ? (
        <p className="px-4 py-6 text-sm text-kumo-subtle">Empty file.</p>
      ) : (
        <>
          {lines.length > 10000 && <p className="px-4 py-2 text-sm text-kumo-subtle">Showing the first 10,000 lines.</p>}
          <table className="w-full border-collapse font-mono text-sm">
          <tbody>
            {lines.slice(0, 10000).map((line, index) => (
              <tr key={index}>
                <td aria-hidden="true" className="w-px select-none border-r border-kumo-line px-3 text-right align-top text-kumo-subtle">{index + 1}</td>
                <td className="whitespace-pre px-4">{line || "\u200b"}</td>
              </tr>
            ))}
          </tbody>
          </table>
        </>
      )}
    </main>
  );
}

import { Button } from "@cloudflare/kumo/components/button";
import { Loader } from "@cloudflare/kumo/components/loader";
import { Fragment, useEffect, useState } from "react";
import type { Comment, CreateCommentRequest, FileContent } from "../../shared/types";
import type { CommentDraftProps } from "../comment-draft";
import { CommentThread } from "./CommentThread";
import { AddCommentButton, UnderRow, anchorKey, type EditingAnchor } from "./DiffTable";

interface FilePreviewProps extends CommentDraftProps {
  path: string;
  active: boolean;
  revision: number;
  connectionVersion: number;
  loadFile: (path: string, signal?: AbortSignal) => Promise<FileContent>;
  comments: Comment[];
  onSubmitComment: (input: CreateCommentRequest) => Promise<void>;
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

export function FilePreview({ path, active, revision, connectionVersion, loadFile, comments, draft: editing, onDraftChange, onSubmitComment, onCarryForward, onResolve, onReopen, onDelete }: FilePreviewProps) {
  const [file, setFile] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setFile(null);
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
  const rows = lines.slice(0, 10000).map((lineText, index) => ({ line: index + 1, lineText, saved: false }));
  if (editing && editing.line > rows.length) rows.push({ ...editing, saved: true });

  const commentsByAnchor = new Map<string, Comment[]>();
  const savedComments: Comment[] = [];
  for (const comment of comments) {
    if (comment.file === path && !comment.historical && !comment.outdated && comment.side === "new"
      && comment.line > 0 && comment.line <= Math.min(lines.length, 10000)
      && lines[comment.line - 1] === comment.lineText) {
      const key = anchorKey(comment.side, comment.line);
      const anchored = commentsByAnchor.get(key) ?? [];
      anchored.push(comment);
      commentsByAnchor.set(key, anchored);
    } else {
      savedComments.push(comment);
    }
  }

  const submitComment = async (body: string) => {
    if (!editing) return;
    const anchor = editing;
    setSaveError(null);
    try {
      if (!active || !file || file.kind !== "text") throw new Error("Reload the file before saving your comment.");
      await onSubmitComment({ file: path, ...anchor, body });
      onDraftChange(null);
    } catch (cause) {
      setSaveError(String(cause));
      throw cause;
    }
  };

  return (
    <main className="min-w-0 flex-1 overflow-auto">
      <div className="sticky top-0 z-10 flex min-h-10 items-center gap-3 border-b border-kumo-line bg-kumo-elevated px-4 py-2">
        <h2 className="min-w-0 flex-1 break-all font-mono text-sm">{path}</h2>
        <span className="shrink-0 text-sm text-kumo-subtle">Unchanged</span>
      </div>
      {savedComments.length > 0 && (
        <section aria-label="Saved file comments" className="flex flex-col gap-px border-b border-kumo-line">
          {savedComments.map((comment) => (
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
      ) : null}
      {lines.length > 10000 && <p className="px-4 py-2 text-sm text-kumo-subtle">Showing the first 10,000 lines.</p>}
      <table className="w-full border-collapse text-sm">
        <tbody>
          {rows.map((row) => {
            const anchor: EditingAnchor = { side: "new", line: row.line, lineText: row.lineText };
            const anchored = commentsByAnchor.get(anchorKey(anchor.side, anchor.line)) ?? [];
            const isEditing = editing?.line === row.line;
            return (
              <Fragment key={row.line}>
                {!row.saved && (
                  <tr className="group font-mono [&_button:focus-visible]:opacity-100">
                    <td className="w-6 align-top">
                      {active && !editing && <AddCommentButton onClick={() => { setSaveError(null); onDraftChange({ ...anchor, body: "" }); }} />}
                    </td>
                    <td aria-hidden="true" className="w-px select-none border-r border-kumo-line px-3 text-right align-top text-kumo-subtle">{row.line}</td>
                    <td className="whitespace-pre px-4">{row.lineText || "\u200b"}</td>
                  </tr>
                )}
                {(anchored.length > 0 || isEditing) && (
                  <tr>
                    <td colSpan={3}>
                      {isEditing && (editing.side === "old" || lines[row.line - 1] !== editing.lineText) && (
                        <div className="bg-kumo-recessed px-4 py-2">
                          <p className="text-kumo-subtle">Draft uses saved text for {editing.side}-side line {editing.line}:</p>
                          <pre className="whitespace-pre-wrap break-all">{editing.lineText || "\u200b"}</pre>
                        </div>
                      )}
                      {isEditing && saveError && <p role="alert" className="px-4 py-2">{saveError}</p>}
                      <UnderRow
                        anchor={isEditing ? editing : anchor}
                        comments={anchored}
                        editing={editing}
                        onDraftBodyChange={(body) => { if (editing) onDraftChange({ ...editing, body }); }}
                        onCancelComment={() => { onDraftChange(null); setSaveError(null); }}
                        onSubmitComment={submitComment}
                        onResolve={onResolve}
                        onReopen={onReopen}
                        onDelete={onDelete}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </main>
  );
}

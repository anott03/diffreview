import { Button } from "@cloudflare/kumo/components/button";
import { Loader } from "@cloudflare/kumo/components/loader";
import type { LineAnnotation } from "@pierre/diffs/react";
import { File } from "@pierre/diffs/react";
import { useEffect, useMemo, useState } from "react";
import type { Comment, CreateCommentRequest, FileContent } from "../../shared/types";
import type { CommentDraftProps } from "../comment-draft";
import { textLines } from "../../core/diff-context";
import { useColorMode } from "../use-color-mode";
import { AddCommentButton } from "./AddCommentButton";
import { AnchorThreads } from "./AnchorThreads";
import { CommentEditor } from "./CommentEditor";
import { CommentThread } from "./CommentThread";
import { codeOptions } from "./pierre-options";

interface FilePreviewProps extends CommentDraftProps {
  path: string;
  active: boolean;
  revision: number;
  connectionVersion: number;
  loadFile: (path: string, signal?: AbortSignal) => Promise<FileContent>;
  comments: Comment[];
  onSubmitComment: (input: CreateCommentRequest) => Promise<boolean>;
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

const MAX_PREVIEW_LINES = 10000;

export function FilePreview({ path, active, revision, connectionVersion, loadFile, comments, draft: editing, onDraftChange, onSubmitComment, onCarryForward, onResolve, onReopen, onDelete }: FilePreviewProps) {
  const [file, setFile] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [saveError, setSaveError] = useState<string | null>(null);
  const colorMode = useColorMode();

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

  const lines = useMemo(() => file?.kind === "text" ? textLines(file.content ?? "") : [], [file]);
  const shown = useMemo(() => lines.slice(0, MAX_PREVIEW_LINES), [lines]);
  const contents = useMemo(() => ({
    name: path,
    contents: shown.join("\n"),
  }), [path, shown]);

  const commentsByLine = new Map<number, Comment[]>();
  const savedComments: Comment[] = [];
  for (const comment of comments) {
    if (comment.file === path && !comment.historical && !comment.outdated && comment.side === "new"
      && comment.line > 0 && comment.line <= shown.length && shown[comment.line - 1] === comment.lineText) {
      commentsByLine.set(comment.line, [...(commentsByLine.get(comment.line) ?? []), comment]);
    } else {
      savedComments.push(comment);
    }
  }
  const draftLine = editing && editing.side === "new" && shown[editing.line - 1] === editing.lineText ? editing.line : null;
  const annotationLines = new Set(commentsByLine.keys());
  if (draftLine !== null) annotationLines.add(draftLine);
  const lineAnnotations = [...annotationLines].sort((a, b) => a - b)
    .map((lineNumber): LineAnnotation<undefined> => ({ lineNumber }));

  const options = useMemo(() => codeOptions(colorMode, active && editing === null), [colorMode, active, editing]);

  const submitComment = async (body: string) => {
    if (!editing) return false;
    const anchor = editing;
    setSaveError(null);
    try {
      if (!active || !file || file.kind !== "text") throw new Error("Reload the file before saving your comment.");
      const saved = await onSubmitComment({ file: path, ...anchor, body });
      if (saved) onDraftChange(null, anchor);
      return saved;
    } catch (cause) {
      setSaveError(String(cause));
      throw cause;
    }
  };
  const changeDraftBody = (body: string) => { if (editing) onDraftChange({ ...editing, body }, editing); };
  const cancelDraft = () => { if (editing) onDraftChange(null, editing); setSaveError(null); };
  const startComment = (hovered: { lineNumber: number } | undefined) => {
    if (!hovered || editing || !active) return;
    const lineText = shown[hovered.lineNumber - 1];
    if (lineText === undefined) return;
    setSaveError(null);
    onDraftChange({ side: "new", line: hovered.lineNumber, lineText, body: "" });
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
      {editing && draftLine === null && (
        <section aria-label="Comment draft" className="border-b border-kumo-line text-sm">
          <div className="bg-kumo-recessed px-4 py-2">
            <p className="text-kumo-subtle">Draft uses saved text for {editing.side}-side line {editing.line}:</p>
            <pre className="whitespace-pre-wrap break-all">{editing.lineText || "\u200b"}</pre>
          </div>
          {saveError && <p role="alert" className="px-4 py-2">{saveError}</p>}
          <CommentEditor body={editing.body} onBodyChange={changeDraftBody} onSubmit={submitComment} onCancel={cancelDraft} />
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
      {lines.length > MAX_PREVIEW_LINES && <p className="px-4 py-2 text-sm text-kumo-subtle">Showing the first 10,000 lines.</p>}
      {file?.kind === "text" && shown.length > 0 && (
        <File
          file={contents}
          options={options}
          lineAnnotations={lineAnnotations}
          renderAnnotation={(annotation) => (
            <AnchorThreads
              comments={commentsByLine.get(annotation.lineNumber) ?? []}
              draft={annotation.lineNumber === draftLine ? editing : null}
              error={saveError}
              onDraftBodyChange={changeDraftBody}
              onCancelDraft={cancelDraft}
              onSubmitDraft={submitComment}
              onResolve={onResolve}
              onReopen={onReopen}
              onDelete={onDelete}
            />
          )}
          renderGutterUtility={(getHoveredLine) => (
            <AddCommentButton onClick={() => startComment(getHoveredLine())} />
          )}
        />
      )}
    </main>
  );
}

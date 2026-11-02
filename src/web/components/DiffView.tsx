import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Collapsible } from "@cloudflare/kumo/components/collapsible";
import type { DiffLineAnnotation, FileDiffOptions } from "@pierre/diffs/react";
import { FileDiff, useStableCallback } from "@pierre/diffs/react";
import { CaretDownIcon, CaretRightIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Comment, CreateCommentRequest, DiffFile, FileContent } from "../../shared/types";
import { diffFilePath } from "../../shared/types";
import type { CommentDraftProps } from "../comment-draft";
import { diffWithContext, validateDiffContent } from "../diff-context";
import { anchorKey, toFileDiffMetadata, visibleDiffLines, type CompleteDiffContent } from "../pierre-diff";
import { useColorMode } from "../use-color-mode";
import { AddCommentButton } from "./AddCommentButton";
import { AnchorThreads } from "./AnchorThreads";
import { CommentEditor } from "./CommentEditor";
import { CommentThread } from "./CommentThread";
import { diffOptions } from "./pierre-options";

export type Layout = "unified" | "split";

export const STATUS_BADGE = {
  added: { variant: "success", label: "added" },
  deleted: { variant: "error", label: "deleted" },
  modified: { variant: "warning", label: "modified" },
  renamed: { variant: "info", label: "renamed" },
} satisfies Record<DiffFile["status"], { variant: "success" | "error" | "warning" | "info"; label: string }>;

type LoadDiffFiles = NonNullable<FileDiffOptions<string, undefined>["loadDiffFiles"]>;

interface LoadedContext extends CompleteDiffContent {
  signature: string;
  reviewId: string;
}

interface DiffViewProps extends CommentDraftProps {
  file: DiffFile;
  workspaceActive: boolean;
  revision: number;
  connectionVersion: number;
  reviewId: string;
  loadContext: (path: string, reviewId: string, signal?: AbortSignal) => Promise<FileContent>;
  layout: Layout;
  comments: Comment[];
  collapsed: boolean;
  onToggleCollapse: () => void;
  onSubmitComment: (input: CreateCommentRequest) => Promise<boolean>;
  onCarryForward: (id: string) => void;
  onResolve: (id: string) => void;
  onReopen: (id: string) => void;
  onDelete: (id: string) => void;
}

export function DiffView({
  file,
  workspaceActive,
  revision,
  connectionVersion,
  loadContext,
  reviewId,
  draft: editing,
  onDraftChange,
  layout,
  comments,
  collapsed,
  onToggleCollapse,
  onSubmitComment,
  onCarryForward,
  onResolve,
  onReopen,
  onDelete,
}: DiffViewProps) {
  const path = diffFilePath(file);
  const colorMode = useColorMode();
  const signature = useMemo(() => JSON.stringify([file, reviewId, revision, connectionVersion]), [file, reviewId, revision, connectionVersion]);
  const [context, setContext] = useState<LoadedContext | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);
  const [loadingContext, setLoadingContext] = useState(false);
  const [renderedGapKeys, setRenderedGapKeys] = useState("");
  const latest = useRef({ signature, reviewId });
  latest.current = { signature, reviewId };
  const pendingLoad = useRef<AbortController | null>(null);

  useEffect(() => () => pendingLoad.current?.abort(), [signature, reviewId, workspaceActive, collapsed]);

  const complete = context?.signature === signature && context.reviewId === reviewId ? context : null;
  const fileDiff = useMemo(() => toFileDiffMetadata(file, complete), [file, complete, signature]);

  const gapLines = useMemo(() => {
    if (!complete) return [];
    const all = new Set(Array.from({ length: file.hunks.length + 1 }, (_, index) => index));
    const expanded = diffWithContext(file, complete.content, all);
    return [...expanded.gaps.keys()].flatMap((index) => expanded.file.hunks[index]!.lines);
  }, [file, complete]);

  const visible = useMemo(() => {
    const lines = visibleDiffLines(file);
    const rendered = new Set(renderedGapKeys.split(","));
    for (const line of gapLines) {
      if (line.newLine === undefined || line.oldLine === undefined || !rendered.has(String(line.newLine))) continue;
      lines.set(anchorKey("old", line.oldLine), line.content);
      lines.set(anchorKey("new", line.newLine), line.content);
    }
    return lines;
  }, [file, gapLines, renderedGapKeys]);

  const { active, outdated } = useMemo(() => {
    const active: Comment[] = [];
    const outdated: Comment[] = [];
    for (const comment of comments) {
      const hidden = visible.get(anchorKey(comment.side, comment.line)) !== comment.lineText;
      (comment.historical || comment.outdated || hidden ? outdated : active).push(comment);
    }
    return { active, outdated };
  }, [comments, visible]);

  const commentsByAnchor = useMemo(() => {
    const map = new Map<string, Comment[]>();
    for (const comment of active) {
      const key = anchorKey(comment.side, comment.line);
      map.set(key, [...(map.get(key) ?? []), comment]);
    }
    return map;
  }, [active]);

  const draftKey = editing && visible.get(anchorKey(editing.side, editing.line)) === editing.lineText
    ? anchorKey(editing.side, editing.line) : null;

  const lineAnnotations = useMemo(() => {
    const keys = new Set(commentsByAnchor.keys());
    if (draftKey) keys.add(draftKey);
    return [...keys].sort().map((key): DiffLineAnnotation<string> => {
      const [side, line] = key.split(":");
      return { side: side === "old" ? "deletions" : "additions", lineNumber: Number(line), metadata: key };
    });
  }, [commentsByAnchor, draftKey]);

  const commentable = workspaceActive && !collapsed && editing === null;

  const loadDiffFiles = useStableCallback<LoadDiffFiles>(async () => {
    if (!workspaceActive || collapsed) throw new Error("Activate and expand this file to load unchanged code.");
    const requested = { signature, reviewId };
    pendingLoad.current?.abort();
    const controller = new AbortController();
    pendingLoad.current = controller;
    setLoadingContext(true);
    setContextError(null);
    try {
      const result = await loadContext(path, reviewId, controller.signal);
      if (result.kind !== "text" || result.content === null) {
        throw new Error("Unchanged code is only available for text files up to 1 MiB.");
      }
      if (result.reviewId !== reviewId) throw new Error("This review ended. Refresh the diff and try again.");
      if (result.baseContent == null) throw new Error("The base file is unavailable or exceeds the 1 MiB context limit.");
      validateDiffContent(file, result.content, result.baseContent);
      if (controller.signal.aborted || latest.current.signature !== requested.signature || latest.current.reviewId !== requested.reviewId) {
        throw new Error("This file changed while loading. Refresh the diff and try again.");
      }
      setContext({ ...requested, content: result.content, baseContent: result.baseContent });
      return {
        oldFile: { name: file.oldPath ?? path, contents: result.baseContent },
        newFile: { name: path, contents: result.content },
      };
    } catch (cause) {
      if (!controller.signal.aborted) setContextError(String(cause));
      throw cause;
    } finally {
      if (pendingLoad.current === controller) {
        pendingLoad.current = null;
        setLoadingContext(false);
      }
    }
  });

  const gapLinesRef = useRef(gapLines);
  gapLinesRef.current = gapLines;
  const onPostRender = useStableCallback<NonNullable<FileDiffOptions<string, undefined>["onPostRender"]>>((_node, instance, phase) => {
    if (phase === "unmount") return;
    const rendered = gapLinesRef.current
      .flatMap((line) => line.newLine !== undefined && instance.isLineRenderable(line.newLine) ? [line.newLine] : [])
      .join(",");
    setRenderedGapKeys((previous) => previous === rendered ? previous : rendered);
  });

  const options = useMemo(() => ({
    ...diffOptions(layout, colorMode, commentable),
    collapsed,
    loadDiffFiles,
    onPostRender,
  }) satisfies FileDiffOptions<string, undefined>, [layout, colorMode, commentable, collapsed, loadDiffFiles, onPostRender]);

  const submit = async (body: string) => {
    if (!editing) return false;
    const submittedDraft = editing;
    const saved = await onSubmitComment({ file: path, ...submittedDraft, reviewId, body });
    if (saved) onDraftChange(null, submittedDraft);
    return saved;
  };
  const changeDraftBody = (body: string) => { if (editing) onDraftChange({ ...editing, body }, editing); };
  const cancelDraft = () => { if (editing) onDraftChange(null, editing); };

  const startComment = (hovered: { lineNumber: number; side: "deletions" | "additions" } | undefined) => {
    if (!hovered || editing || !workspaceActive || collapsed) return;
    const side = hovered.side === "deletions" ? "old" : "new";
    const lineText = visible.get(anchorKey(side, hovered.lineNumber));
    if (lineText === undefined) return;
    onDraftChange({ side, line: hovered.lineNumber, lineText, body: "" });
  };

  const status = STATUS_BADGE[file.status];

  return (
    <Collapsible.Root
      open={!collapsed}
      onOpenChange={() => onToggleCollapse()}
      className="flex flex-col"
    >
      <div className="sticky top-0 z-10 flex h-10 items-center gap-2 border-b border-kumo-line bg-kumo-elevated px-4">
        <Collapsible.Trigger
          render={
            <Button
              shape="square"
              variant="ghost"
              size="sm"
              aria-label={collapsed ? "Expand diff" : "Collapse diff"}
            />
          }
        >
          {collapsed ? <CaretRightIcon size={16} /> : <CaretDownIcon size={16} />}
        </Collapsible.Trigger>
        <Badge variant={status.variant}>{status.label}</Badge>
        <span className="font-mono text-sm">
          {file.status === "renamed" ? `${file.oldPath} → ${file.newPath}` : path}
        </span>
        <span className="flex-1" />
        <span className="font-mono text-xs">
          <span className="text-kumo-success">+{file.additions}</span>{" "}
          <span className="text-kumo-danger">−{file.deletions}</span>
        </span>
      </div>

      <Collapsible.Panel>
        {editing && !draftKey && (
          <section aria-label="Comment draft" className="border-b border-kumo-line text-sm">
            <div className="bg-kumo-recessed px-4 py-2">
              <p className="text-kumo-subtle">Draft on {editing.side}-side line {editing.line}</p>
              <pre className="whitespace-pre-wrap break-all">{editing.lineText || "\u200b"}</pre>
            </div>
            <CommentEditor body={editing.body} onBodyChange={changeDraftBody} onSubmit={submit} onCancel={cancelDraft} />
          </section>
        )}
        {loadingContext && <p role="status" className="px-4 py-2 text-sm text-kumo-subtle">Loading unchanged code…</p>}
        {contextError && (
          <p role="alert" className="px-4 py-2 text-sm">
            {contextError} Expand the hidden lines again to retry.
          </p>
        )}
        {outdated.length > 0 && (
          <details className="border-b border-kumo-line">
            <summary className="cursor-pointer px-4 py-2 text-xs text-kumo-subtle select-none">
              {outdated.length} comment{outdated.length === 1 ? "" : "s"} on hidden or outdated code
            </summary>
            <div className="flex flex-col gap-px pb-px">
              {outdated.map((comment) => (
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
            </div>
          </details>
        )}
        {file.isBinary ? (
          <div className="px-4 py-6 text-sm text-kumo-subtle">
            Binary file — no textual diff to display.
          </div>
        ) : file.hunks.length === 0 && (!complete || fileDiff.additionLines.length === 0) && (
          <div className="flex items-center gap-3 px-4 py-2 font-mono text-xs text-kumo-subtle">
            <span>{file.status === "renamed" ? "Renamed without content changes" : "Empty file"}</span>
            {!complete && file.oldPath && file.newPath && (
              <Button variant="ghost" size="sm" disabled={!workspaceActive || loadingContext} onClick={() => { void loadDiffFiles(fileDiff).catch(() => {}); }}>
                Show unchanged code
              </Button>
            )}
          </div>
        )}
      </Collapsible.Panel>
      {!file.isBinary && fileDiff.hunks.some((hunk) => hunk.hunkContent.length > 0) && (
        <div hidden={collapsed}>
          <FileDiff<string>
            key={signature}
            fileDiff={fileDiff}
            options={options}
            lineAnnotations={lineAnnotations}
            renderAnnotation={(annotation) => (
              <AnchorThreads
                comments={commentsByAnchor.get(annotation.metadata) ?? []}
                draft={annotation.metadata === draftKey ? editing : null}
                onDraftBodyChange={changeDraftBody}
                onCancelDraft={cancelDraft}
                onSubmitDraft={submit}
                onResolve={onResolve}
                onReopen={onReopen}
                onDelete={onDelete}
              />
            )}
            renderGutterUtility={(getHoveredLine) => (
              <AddCommentButton onClick={() => startComment(getHoveredLine())} />
            )}
          />
        </div>
      )}
    </Collapsible.Root>
  );
}

import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Collapsible } from "@cloudflare/kumo/components/collapsible";
import type { DiffLineAnnotation, FileDiffMetadata, FileDiffOptions } from "@pierre/diffs/react";
import { FileDiff } from "@pierre/diffs/react";
import { CaretDownIcon, CaretRightIcon } from "@phosphor-icons/react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Comment, CreateCommentRequest, DiffFile, DiffLine, FileContent } from "../../shared/types";
import { diffFilePath } from "../../shared/types";
import type { CommentDraftProps } from "../comment-draft";
import { diffWithContext, validateDiffContent } from "../../core/diff-context";
import { anchorKey, visibleDiffLines } from "../../core/diff-model";
import { toFileDiffMetadata, type CompleteDiffContent } from "../pierre-diff";
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
type PostRender = NonNullable<FileDiffOptions<string, undefined>["onPostRender"]>;
type DiffRenderer = Parameters<PostRender>[1];

interface LoadedContext extends CompleteDiffContent {
  metadata: FileDiffMetadata;
  gapLines: DiffLine[];
}

interface RenderedContext {
  context: LoadedContext;
  lines: Set<number>;
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

export function DiffView(props: DiffViewProps) {
  const { file, reviewId, revision, connectionVersion } = props;
  const generation = useMemo(() => JSON.stringify([file, reviewId, revision, connectionVersion]), [file, reviewId, revision, connectionVersion]);
  return <ReviewDiff key={generation} {...props} />;
}

function ReviewDiff({
  file,
  workspaceActive,
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
  const [context, setContext] = useState<LoadedContext | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);
  const [loadingContext, setLoadingContext] = useState(false);
  const [renderedContext, setRenderedContext] = useState<RenderedContext | null>(null);
  const acceptedContext = useRef<LoadedContext | null>(null);
  const mounted = useRef(true);
  const available = useRef(false);
  available.current = workspaceActive && !collapsed;
  const pendingLoad = useRef<AbortController | null>(null);
  const renderer = useRef<DiffRenderer | null>(null);
  const retiredRenderers = useRef(new WeakSet<DiffRenderer>());

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pendingLoad.current?.abort();
    };
  }, []);
  useLayoutEffect(() => {
    if (!workspaceActive || collapsed) pendingLoad.current?.abort();
  }, [workspaceActive, collapsed]);

  const partial = useMemo(() => toFileDiffMetadata(file, null), [file]);
  const fileDiff = context?.metadata ?? partial;

  const visible = useMemo(() => {
    const lines = visibleDiffLines(file);
    if (!context || renderedContext?.context !== context) return lines;
    for (const line of context.gapLines) {
      if (line.newLine === undefined || line.oldLine === undefined || !renderedContext.lines.has(line.newLine)) continue;
      lines.set(anchorKey("old", line.oldLine), line.content);
      lines.set(anchorKey("new", line.newLine), line.content);
    }
    return lines;
  }, [file, context, renderedContext]);

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
    return [...keys].map((key): DiffLineAnnotation<string> => {
      const [side, line] = key.split(":");
      return { side: side === "old" ? "deletions" : "additions", lineNumber: Number(line), metadata: key };
    }).sort((left, right) => left.lineNumber - right.lineNumber
      || (left.side === right.side ? 0 : left.side === "deletions" ? -1 : 1));
  }, [commentsByAnchor, draftKey]);

  const commentable = workspaceActive && !collapsed && editing === null;

  const loadDiffFiles = useCallback<LoadDiffFiles>(async (requestedDiff) => {
    if (!mounted.current || !available.current) throw new Error("Activate and expand this file to load unchanged code.");
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
      if (!mounted.current || !available.current || controller.signal.aborted || pendingLoad.current !== controller) {
        throw new Error("This file changed while loading. Refresh the diff and try again.");
      }
      const contents = { content: result.content, baseContent: result.baseContent };
      const all = new Set(Array.from({ length: file.hunks.length + 1 }, (_, index) => index));
      const expanded = diffWithContext(file, contents.content, all);
      const accepted: LoadedContext = {
        ...contents,
        metadata: toFileDiffMetadata(file, contents),
        gapLines: [...expanded.gaps.keys()].flatMap((index) => expanded.file.hunks[index]!.lines),
      };
      // Pierre appends :hydrated to this key. Include both full contents before
      // hydration so identical partial patches cannot share different full files.
      requestedDiff.cacheKey = `${accepted.metadata.cacheKey}:hydrating`;
      acceptedContext.current = accepted;
      setContext(accepted);
      return {
        oldFile: { name: file.oldPath ?? path, contents: result.baseContent },
        newFile: { name: path, contents: result.content },
      };
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted) setContextError(String(cause));
      throw cause;
    } finally {
      if (pendingLoad.current === controller) {
        pendingLoad.current = null;
        if (mounted.current) setLoadingContext(false);
      }
    }
  }, [file, reviewId, loadContext, path]);

  const onPostRender = useCallback<PostRender>((_node, instance, phase) => {
    if (phase === "unmount") {
      retiredRenderers.current.add(instance);
      if (renderer.current === instance) renderer.current = null;
      return;
    }
    if (retiredRenderers.current.has(instance)) return;
    if (phase === "mount") renderer.current = instance;
    if (!mounted.current || renderer.current !== instance) return;
    const accepted = acceptedContext.current;
    if (!accepted || instance.fileDiff?.isPartial !== false) return;
    const key = instance.fileDiff.cacheKey;
    if (key !== accepted.metadata.cacheKey && key !== `${accepted.metadata.cacheKey}:hydrating:hydrated`) return;
    const lines = new Set(accepted.gapLines.flatMap((line) =>
      line.newLine !== undefined && instance.isLineRenderable(line.newLine) ? [line.newLine] : []));
    setRenderedContext((previous) => previous?.context === accepted && previous.lines.size === lines.size
      && [...lines].every((line) => previous.lines.has(line)) ? previous : { context: accepted, lines });
  }, []);

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
        ) : file.hunks.length === 0 && (!context || fileDiff.additionLines.length === 0) && (
          <div className="flex items-center gap-3 px-4 py-2 font-mono text-xs text-kumo-subtle">
            <span>{file.status === "renamed" ? "Renamed without content changes" : "Empty file"}</span>
            {!context && file.oldPath && file.newPath && (
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

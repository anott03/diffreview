import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Collapsible } from "@cloudflare/kumo/components/collapsible";
import { CaretDownIcon, CaretRightIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import type { Comment, CreateCommentRequest, DiffFile, FileContent } from "../../shared/types";
import { diffFilePath } from "../../shared/types";
import type { CommentDraftProps } from "../comment-draft";
import { diffWithContext, validateDiffContent } from "../diff-context";
import { CommentEditor } from "./CommentEditor";
import { CommentThread } from "./CommentThread";
import { anchorKey, SplitDiffTable, UnifiedDiffTable, type EditingAnchor } from "./DiffTable";

export type Layout = "unified" | "split";

const STATUS_BADGE = {
  added: { variant: "success", label: "added" },
  deleted: { variant: "error", label: "deleted" },
  modified: { variant: "warning", label: "modified" },
  renamed: { variant: "info", label: "renamed" },
} satisfies Record<DiffFile["status"], { variant: "success" | "error" | "warning" | "info"; label: string }>;

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
  onSubmitComment: (input: CreateCommentRequest) => Promise<void>;
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
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [context, setContext] = useState<{ signature: string; content: string } | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);
  const [loadingContext, setLoadingContext] = useState(false);
  const [retry, setRetry] = useState(0);
  const signature = JSON.stringify(file);
  const needsContext = expanded.size > 0;

  useEffect(() => {
    if (!workspaceActive || collapsed || !needsContext) return;
    const controller = new AbortController();
    setLoadingContext(true);
    setContextError(null);
    void loadContext(path, reviewId, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.kind !== "text" || result.content === null) {
        throw new Error("Unchanged code is only available for text files up to 1 MiB.");
      }
      if (result.reviewId !== reviewId) throw new Error("This review ended. Refresh the diff and try again.");
      if (result.baseContent == null) throw new Error("The base file is unavailable or exceeds the 1 MiB context limit.");
      validateDiffContent(file, result.content, result.baseContent);
      setContext({ signature, content: result.content });
    }).catch((cause) => {
      if (!controller.signal.aborted) setContextError(String(cause));
    }).finally(() => {
      if (!controller.signal.aborted) setLoadingContext(false);
    });
    return () => controller.abort();
  }, [workspaceActive, collapsed, needsContext, file, signature, path, loadContext, reviewId, revision, connectionVersion, retry]);

  const displayed = useMemo(() => diffWithContext(
    file, context?.signature === signature ? context.content : null, expanded,
  ), [file, context, signature, expanded]);

  const { active, outdated } = useMemo(() => {
    const active: Comment[] = [];
    const outdated: Comment[] = [];
    const visible = new Map<string, string>();
    for (const hunk of displayed.file.hunks) {
      for (const line of hunk.lines) {
        if (line.oldLine !== undefined) visible.set(anchorKey("old", line.oldLine), line.content);
        if (line.newLine !== undefined) visible.set(anchorKey("new", line.newLine), line.content);
      }
    }
    for (const comment of comments) {
      const hidden = visible.get(anchorKey(comment.side, comment.line)) !== comment.lineText;
      (comment.historical || comment.outdated || hidden ? outdated : active).push(comment);
    }
    return { active, outdated };
  }, [comments, displayed]);

  const commentsByAnchor = useMemo(() => {
    const map = new Map<string, Comment[]>();
    for (const comment of active) {
      const key = anchorKey(comment.side, comment.line);
      map.set(key, [...(map.get(key) ?? []), comment]);
    }
    return map;
  }, [active]);

  const submit = async (body: string) => {
    if (!editing) return;
    await onSubmitComment({ file: path, ...editing, body });
    onDraftChange(null);
  };

  const draftVisible = editing !== null && displayed.file.hunks.some((hunk) => hunk.lines.some((line) =>
    (editing.side === "old" ? line.oldLine : line.newLine) === editing.line && line.content === editing.lineText));
  const changeDraftBody = (body: string) => { if (editing) onDraftChange({ ...editing, body }); };
  const status = STATUS_BADGE[file.status];
  const tableProps = {
    file: displayed.file,
    renderHunkHeader: (index: number) => {
      const gap = displayed.gaps.get(index);
      if (!gap) return displayed.file.hunks[index]!.header;
      const containsDraft = editing !== null && displayed.file.hunks[index]!.lines.some((line) =>
        (editing.side === "old" ? line.oldLine : line.newLine) === editing.line);
      return (
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={gap.expanded}
          disabled={loadingContext || containsDraft}
          onClick={() => setExpanded((previous) => {
            const next = new Set(previous);
            if (next.has(gap.id)) next.delete(gap.id);
            else next.add(gap.id);
            return next;
          })}
        >
          {gap.expanded ? "Hide" : "Expand"} {gap.count === null ? "remaining" : gap.count} unchanged lines
        </Button>
      );
    },
    commentsByAnchor,
    editing: draftVisible ? editing : null,
    onDraftBodyChange: changeDraftBody,
    onStartComment: (anchor: EditingAnchor) => { if (!editing) onDraftChange({ ...anchor, body: "" }); },
    onCancelComment: () => onDraftChange(null),
    onSubmitComment: submit,
    onResolve,
    onReopen,
    onDelete,
  };

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
        {editing && !draftVisible && (
          <section aria-label="Comment draft" className="border-b border-kumo-line text-sm">
            <div className="bg-kumo-recessed px-4 py-2">
              <p className="text-kumo-subtle">Draft on {editing.side}-side line {editing.line}</p>
              <pre className="whitespace-pre-wrap break-all">{editing.lineText || "\u200b"}</pre>
            </div>
            <CommentEditor body={editing.body} onBodyChange={changeDraftBody} onSubmit={submit} onCancel={() => onDraftChange(null)} />
          </section>
        )}
        {loadingContext && <p role="status" className="px-4 py-2 text-sm text-kumo-subtle">Loading unchanged code…</p>}
        {contextError && (
          <div role="alert" className="flex items-center gap-3 px-4 py-2 text-sm">
            <span>{contextError}</span>
            <Button variant="secondary" size="sm" onClick={() => setRetry((value) => value + 1)}>Retry</Button>
          </div>
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
        ) : layout === "unified" ? (
          <UnifiedDiffTable {...tableProps} />
        ) : (
          <SplitDiffTable {...tableProps} />
        )}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

import { Badge } from "@cloudflare/kumo";
import { useMemo, useState } from "react";
import type { Comment, CreateCommentRequest, DiffFile } from "../../shared/types";
import { diffFilePath } from "../../shared/types";
import { CommentThread } from "./CommentThread";
import { anchorKey, SplitDiffTable, UnifiedDiffTable, type EditingAnchor } from "./DiffTable";

export type Layout = "unified" | "split";

const STATUS_BADGE: Record<DiffFile["status"], { variant: "success" | "error" | "warning" | "info"; label: string }> = {
  added: { variant: "success", label: "added" },
  deleted: { variant: "error", label: "deleted" },
  modified: { variant: "warning", label: "modified" },
  renamed: { variant: "info", label: "renamed" },
};

interface DiffViewProps {
  file: DiffFile;
  layout: Layout;
  comments: Comment[];
  onSubmitComment: (input: CreateCommentRequest) => Promise<void>;
  onReopen: (id: string) => void;
  onDelete: (id: string) => void;
}

export function DiffView({ file, layout, comments, onSubmitComment, onReopen, onDelete }: DiffViewProps) {
  const [editing, setEditing] = useState<EditingAnchor | null>(null);
  const path = diffFilePath(file);

  const { active, outdated } = useMemo(() => {
    const active: Comment[] = [];
    const outdated: Comment[] = [];
    for (const comment of comments) {
      (comment.outdated ? outdated : active).push(comment);
    }
    return { active, outdated };
  }, [comments]);

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
    setEditing(null);
  };

  const status = STATUS_BADGE[file.status];
  const tableProps = {
    file,
    commentsByAnchor,
    editing,
    onStartComment: setEditing,
    onCancelComment: () => setEditing(null),
    onSubmitComment: submit,
    onReopen,
    onDelete,
  };

  return (
    <div className="flex flex-col">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-kumo-line bg-kumo-elevated px-4 py-2">
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

      {outdated.length > 0 && (
        <details className="border-b border-kumo-line">
          <summary className="cursor-pointer px-4 py-2 text-xs text-kumo-subtle select-none">
            {outdated.length} outdated comment{outdated.length === 1 ? "" : "s"} (anchored to code
            that has since changed)
          </summary>
          <div className="flex flex-col gap-px pb-px">
            {outdated.map((comment) => (
              <CommentThread key={comment.id} comment={comment} onReopen={onReopen} onDelete={onDelete} />
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
    </div>
  );
}

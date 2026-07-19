import { cn } from "@cloudflare/kumo";
import { Plus } from "@phosphor-icons/react";
import { Fragment } from "react";
import type { Comment, CommentSide, DiffFile, DiffLine } from "../../shared/types";
import { CommentEditor } from "./CommentEditor";
import { CommentThread } from "./CommentThread";

export interface EditingAnchor {
  side: CommentSide;
  line: number;
  lineText: string;
}

export function anchorKey(side: CommentSide, line: number): string {
  return `${side}:${line}`;
}

interface DiffTableProps {
  file: DiffFile;
  commentsByAnchor: Map<string, Comment[]>;
  editing: EditingAnchor | null;
  onStartComment: (anchor: EditingAnchor) => void;
  onCancelComment: () => void;
  onSubmitComment: (body: string) => Promise<void>;
  onReopen: (id: string) => void;
  onDelete: (id: string) => void;
}

// ---------------------------------------------------------------------------
// Shared row pieces
// ---------------------------------------------------------------------------

function AddCommentButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Add review comment"
      className="m-0.5 flex h-4 w-4 items-center justify-center rounded-sm bg-kumo-brand text-white opacity-0 transition-opacity group-hover:opacity-100"
    >
      <Plus size={10} weight="bold" />
    </button>
  );
}

function LineNo({ value }: { value?: number }) {
  return (
    <span className="block select-none pr-2 text-right text-kumo-subtle">{value ?? ""}</span>
  );
}

interface UnderRowProps extends Pick<DiffTableProps, "editing" | "onCancelComment" | "onSubmitComment" | "onReopen" | "onDelete"> {
  anchor: EditingAnchor;
  comments: Comment[];
}

/** Comment threads and/or the editor rendered beneath a diff row. */
function UnderRow({ anchor, comments, editing, onCancelComment, onSubmitComment, onReopen, onDelete }: UnderRowProps) {
  const isEditing =
    editing !== null && editing.side === anchor.side && editing.line === anchor.line;
  if (comments.length === 0 && !isEditing) return null;
  return (
    <div className="flex flex-col gap-px border-y border-kumo-line bg-kumo-base py-px">
      {comments.map((comment) => (
        <CommentThread key={comment.id} comment={comment} onReopen={onReopen} onDelete={onDelete} />
      ))}
      {isEditing && <CommentEditor onSubmit={onSubmitComment} onCancel={onCancelComment} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Unified layout
// ---------------------------------------------------------------------------

export function UnifiedDiffTable(props: DiffTableProps) {
  const { file, commentsByAnchor, onStartComment } = props;
  return (
    <div className="font-mono text-xs leading-5">
      {file.hunks.map((hunk, hunkIndex) => (
        <Fragment key={hunkIndex}>
          <div className="border-y border-kumo-line bg-kumo-recessed px-3 py-1 text-kumo-subtle select-none">
            {hunk.header}
          </div>
          {hunk.lines.map((line, lineIndex) => {
            const side: CommentSide = line.type === "del" ? "old" : "new";
            const lineNo = (side === "old" ? line.oldLine : line.newLine)!;
            const anchor: EditingAnchor = { side, line: lineNo, lineText: line.content };
            const comments = commentsByAnchor.get(anchorKey(side, lineNo)) ?? [];
            return (
              <Fragment key={lineIndex}>
                <div
                  className={cn(
                    "group grid grid-cols-[1.5rem_3rem_3rem_1fr]",
                    line.type === "add" && "diff-add",
                    line.type === "del" && "diff-del",
                  )}
                >
                  <span className="flex justify-center">
                    <AddCommentButton onClick={() => onStartComment(anchor)} />
                  </span>
                  <LineNo value={line.oldLine} />
                  <LineNo value={line.newLine} />
                  <span className="whitespace-pre-wrap break-all pr-4">
                    <span className="select-none text-kumo-subtle">
                      {line.type === "add" ? "+" : line.type === "del" ? "-" : " "}
                    </span>
                    {line.content}
                  </span>
                </div>
                <UnderRow
                  anchor={anchor}
                  comments={comments}
                  editing={props.editing}
                  onCancelComment={props.onCancelComment}
                  onSubmitComment={props.onSubmitComment}
                  onReopen={props.onReopen}
                  onDelete={props.onDelete}
                />
              </Fragment>
            );
          })}
        </Fragment>
      ))}
      {file.hunks.length === 0 && (
        <div className="px-3 py-2 text-kumo-subtle">Empty file</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Split (side-by-side) layout
// ---------------------------------------------------------------------------

interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

/** Pairs del/add runs into aligned rows; context lines span both columns. */
function pairHunkLines(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.type === "context") {
      rows.push({ left: line, right: line });
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i]!.type === "del") dels.push(lines[i++]!);
    while (i < lines.length && lines[i]!.type === "add") adds.push(lines[i++]!);
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
  }
  return rows;
}

function SplitCell({
  line,
  prefix,
  tinted,
}: {
  line: DiffLine | null;
  prefix: "+" | "-";
  tinted: boolean;
}) {
  return (
    <span className={cn("whitespace-pre-wrap break-all pr-4", tinted && line && (prefix === "+" ? "diff-add" : "diff-del"))}>
      {line && (
        <>
          <span className="select-none text-kumo-subtle">{prefix}</span>
          {line.content}
        </>
      )}
    </span>
  );
}

export function SplitDiffTable(props: DiffTableProps) {
  const { file, commentsByAnchor, onStartComment } = props;
  return (
    <div className="font-mono text-xs leading-5">
      {file.hunks.map((hunk, hunkIndex) => (
        <Fragment key={hunkIndex}>
          <div className="border-y border-kumo-line bg-kumo-recessed px-3 py-1 text-kumo-subtle select-none">
            {hunk.header}
          </div>
          {pairHunkLines(hunk.lines).map((row, rowIndex) => {
            const leftAnchor: EditingAnchor | null = row.left
              ? { side: "old", line: row.left.oldLine!, lineText: row.left.content }
              : null;
            const rightAnchor: EditingAnchor | null = row.right
              ? { side: "new", line: row.right.newLine!, lineText: row.right.content }
              : null;
            const leftComments = leftAnchor
              ? (commentsByAnchor.get(anchorKey(leftAnchor.side, leftAnchor.line)) ?? [])
              : [];
            const rightComments = rightAnchor
              ? (commentsByAnchor.get(anchorKey(rightAnchor.side, rightAnchor.line)) ?? [])
              : [];
            return (
              <Fragment key={rowIndex}>
                <div className="group grid grid-cols-[1.5rem_3rem_1fr_1.5rem_3rem_1fr]">
                  <span className="flex justify-center">
                    {leftAnchor && <AddCommentButton onClick={() => onStartComment(leftAnchor)} />}
                  </span>
                  <LineNo value={row.left?.oldLine} />
                  <SplitCell line={row.left} prefix="-" tinted={row.left?.type === "del"} />
                  <span className="flex justify-center border-l border-kumo-line">
                    {rightAnchor && <AddCommentButton onClick={() => onStartComment(rightAnchor)} />}
                  </span>
                  <LineNo value={row.right?.newLine} />
                  <SplitCell line={row.right} prefix="+" tinted={row.right?.type === "add"} />
                </div>
                {leftAnchor && (
                  <UnderRow
                    anchor={leftAnchor}
                    comments={leftComments}
                    editing={props.editing}
                    onCancelComment={props.onCancelComment}
                    onSubmitComment={props.onSubmitComment}
                    onReopen={props.onReopen}
                    onDelete={props.onDelete}
                  />
                )}
                {rightAnchor && (
                  <UnderRow
                    anchor={rightAnchor}
                    comments={rightComments}
                    editing={props.editing}
                    onCancelComment={props.onCancelComment}
                    onSubmitComment={props.onSubmitComment}
                    onReopen={props.onReopen}
                    onDelete={props.onDelete}
                  />
                )}
              </Fragment>
            );
          })}
        </Fragment>
      ))}
      {file.hunks.length === 0 && (
        <div className="px-3 py-2 text-kumo-subtle">Empty file</div>
      )}
    </div>
  );
}

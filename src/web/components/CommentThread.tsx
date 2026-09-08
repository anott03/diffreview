import { Badge, Button } from "@cloudflare/kumo";
import { ArrowCounterClockwise, ArrowRight, Check, Trash } from "@phosphor-icons/react";
import type { Comment } from "../../shared/types";
import { CommentContext } from "./CommentContext";
import { Markdown } from "./Markdown";

function timeAgo(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

interface CommentThreadProps {
  comment: Comment;
  onResolve: (id: string) => void;
  onReopen: (id: string) => void;
  onDelete: (id: string) => void;
  showContext?: boolean;
  onCarryForward?: (id: string) => void;
}

export function CommentThread({ comment, onResolve, onReopen, onDelete, onCarryForward, showContext = false }: CommentThreadProps) {
  return (
    <div className="border-l-2 border-kumo-brand bg-kumo-elevated px-4 py-2.5 font-sans">
      <div className="mb-1 flex items-center gap-2">
        {comment.status === "addressed" && <Badge variant="success">addressed</Badge>}
        {comment.historical ? (
          <Badge variant="secondary">
            <span
              className={comment.reviewHead ? "font-mono" : undefined}
              title={comment.reviewHead ? `Review based on ${comment.reviewHead}` : undefined}
            >
              {comment.reviewHead ? comment.reviewHead.slice(0, 7)
                : comment.reviewHead === "" ? "unborn HEAD"
                : comment.reviewId ? "unknown commit" : "no review"}
            </span>
          </Badge>
        ) : comment.outdated && <Badge variant="warning">outside current diff</Badge>}
        <span className="text-xs text-kumo-subtle">
          line {comment.line} · {timeAgo(comment.createdAt)}
        </span>
        <span className="flex-1" />
        {comment.historical && onCarryForward && (
          <Button
            size="xs"
            variant="ghost"
            icon={<ArrowRight size={12} />}
            className="leading-none"
            onClick={() => onCarryForward(comment.id)}
            title="Carry forward to the current review"
          >
            <span>Carry forward</span>
          </Button>
        )}
        {comment.status === "open" && (
          <Button
            size="xs"
            variant="ghost"
            icon={<Check size={12} />}
            className="leading-none"
            onClick={() => onResolve(comment.id)}
            title="Resolve this comment"
          >
            <span>Resolve</span>
          </Button>
        )}
        {comment.status === "addressed" && (
          <Button
            size="xs"
            variant="ghost"
            icon={<ArrowCounterClockwise size={12} />}
            className="leading-none"
            onClick={() => onReopen(comment.id)}
            title="Reopen this comment"
          >
            <span>Reopen</span>
          </Button>
        )}
        <Button
          size="xs"
          variant="ghost"
          shape="square"
          className="size-5"
          icon={<Trash size={12} />}
          onClick={() => onDelete(comment.id)}
          aria-label="Delete comment"
          title="Delete comment"
        />
      </div>
      <Markdown className="py-1">{comment.body}</Markdown>
      {showContext && <CommentContext comment={comment} />}
      {comment.status === "addressed" && comment.note && (
        <div className="mt-1.5 border-t border-kumo-line pt-1.5 text-xs text-kumo-subtle">
          <span className="font-medium text-kumo-success">agent:</span>{" "}
          <Markdown className="inline align-baseline text-xs">{comment.note}</Markdown>
        </div>
      )}
    </div>
  );
}

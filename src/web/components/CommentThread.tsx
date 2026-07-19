import { Badge, Button } from "@cloudflare/kumo";
import { ArrowCounterClockwise, Trash } from "@phosphor-icons/react";
import type { Comment } from "../../shared/types";

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
  onReopen: (id: string) => void;
  onDelete: (id: string) => void;
}

export function CommentThread({ comment, onReopen, onDelete }: CommentThreadProps) {
  return (
    <div className="border-l-2 border-kumo-brand bg-kumo-elevated px-4 py-2.5">
      <div className="mb-1 flex items-center gap-2">
        <Badge variant="secondary">you</Badge>
        {comment.status === "addressed" && <Badge variant="success">addressed</Badge>}
        {comment.outdated && <Badge variant="warning">outdated</Badge>}
        <span className="text-xs text-kumo-subtle">
          line {comment.line} · {timeAgo(comment.createdAt)}
        </span>
        <span className="flex-1" />
        {comment.status === "addressed" && (
          <Button
            size="xs"
            variant="ghost"
            icon={<ArrowCounterClockwise size={12} />}
            onClick={() => onReopen(comment.id)}
            title="Reopen this comment"
          >
            Reopen
          </Button>
        )}
        <Button
          size="xs"
          variant="ghost"
          shape="square"
          icon={<Trash size={12} />}
          onClick={() => onDelete(comment.id)}
          aria-label="Delete comment"
          title="Delete comment"
        />
      </div>
      <p className="text-sm whitespace-pre-wrap">{comment.body}</p>
      {comment.status === "addressed" && comment.note && (
        <p className="mt-1.5 border-t border-kumo-line pt-1.5 text-xs text-kumo-subtle">
          <span className="font-medium text-kumo-success">agent:</span> {comment.note}
        </p>
      )}
    </div>
  );
}

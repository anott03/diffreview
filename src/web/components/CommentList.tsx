import { Tabs } from "@cloudflare/kumo/components/tabs";
import type { Comment, CommentStatus } from "../../shared/types";
import { CommentThread } from "./CommentThread";

interface CommentListProps {
  comments: Comment[];
  status: CommentStatus | "all";
  onStatusChange: (status: CommentStatus | "all") => void;
  onCarryForward: (id: string) => void;
  onResolve: (id: string) => void;
  onReopen: (id: string) => void;
  onDelete: (id: string) => void;
}

export function CommentList({ comments, status, onStatusChange, onCarryForward, onResolve, onReopen, onDelete }: CommentListProps) {
  const groups = new Map<string, Comment[]>();
  for (const comment of comments) {
    if (status !== "all" && comment.status !== status) continue;
    const group = groups.get(comment.file) ?? [];
    group.push(comment);
    groups.set(comment.file, group);
  }

  return (
    <main className="min-w-0 flex-1 overflow-y-auto">
      <div className="sticky top-0 z-10 flex items-center gap-4 border-b border-kumo-line bg-kumo-elevated px-4 py-2">
        <h1 className="text-sm font-semibold">Review comments</h1>
        <Tabs
          size="sm"
          tabs={[
            { value: "open", label: "Open" },
            { value: "addressed", label: "Addressed" },
            { value: "all", label: "All" },
          ]}
          value={status}
          onValueChange={(value) => onStatusChange(value as CommentStatus | "all")}
        />
      </div>
      {groups.size === 0 ? (
        <p className="px-4 py-6 text-sm text-kumo-subtle">
          {status === "all" ? "No review comments yet." : `No ${status} comments.`}
        </p>
      ) : (
        [...groups].map(([file, threads]) => (
          <section key={file} className="mb-4">
            <h2 className="border-y border-kumo-line bg-kumo-base px-4 py-2 font-mono text-sm break-all">{file}</h2>
            <div className="flex flex-col gap-2 px-4 py-3">
              {threads.map((comment) => (
                <CommentThread key={comment.id} comment={comment} showContext onCarryForward={onCarryForward} onResolve={onResolve} onReopen={onReopen} onDelete={onDelete} />
              ))}
            </div>
          </section>
        ))
      )}
    </main>
  );
}

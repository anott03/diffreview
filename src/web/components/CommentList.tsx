import { Tabs } from "@cloudflare/kumo/components/tabs";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Collapsible } from "@cloudflare/kumo/components/collapsible";
import { Select } from "@cloudflare/kumo/components/select";
import { CaretDownIcon, CaretRightIcon } from "@phosphor-icons/react";
import type { Comment, CommentStatus } from "../../shared/types";
import { groupComments, sortComments, type CommentGrouping, type CommentSort } from "../comment-groups";
import { CommentThread } from "./CommentThread";

interface CommentListProps {
  comments: Comment[];
  status: CommentStatus | "all";
  sort: CommentSort;
  grouping: CommentGrouping;
  onGroupingChange: (grouping: CommentGrouping) => void;
  onSortChange: (sort: CommentSort) => void;
  collapsedPaths: Set<string>;
  onToggleCollapse: (file: string) => void;
  onStatusChange: (status: CommentStatus | "all") => void;
  onCarryForward: (id: string) => void;
  onResolve: (id: string) => void;
  onReopen: (id: string) => void;
  onDelete: (id: string) => void;
}

export function CommentList({ comments, status, sort, grouping, onGroupingChange, onSortChange, collapsedPaths, onToggleCollapse, onStatusChange, onCarryForward, onResolve, onReopen, onDelete }: CommentListProps) {
  const visible = sortComments(comments, status, sort);
  const renderComment = (comment: Comment) => (
    <CommentThread key={comment.id} comment={comment} showContext onCarryForward={onCarryForward} onResolve={onResolve} onReopen={onReopen} onDelete={onDelete} />
  );

  return (
    <main className="isolate min-w-0 flex-1 overflow-y-auto">
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-4 border-b border-kumo-line bg-kumo-elevated px-4 py-2">
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
        <Tabs
          size="sm"
          tabs={[
            { value: "file", label: "By file" },
            { value: "list", label: "List" },
          ]}
          value={grouping}
          onValueChange={(value) => onGroupingChange(value as CommentGrouping)}
        />
        <Select
          size="sm"
          aria-label="Sort comments"
          value={sort}
          onValueChange={(value) => { if (value) onSortChange(value); }}
          items={{ newest: "Most recent", oldest: "Oldest first" }}
        />
      </div>
      {visible.length === 0 ? (
        <p className="px-4 py-6 text-sm text-kumo-subtle">
          {status === "all" ? "No review comments yet." : `No ${status} comments.`}
        </p>
      ) : grouping === "list" ? (
        <ol className="flex flex-col gap-3 px-4 py-3">
          {visible.map((comment) => (
            <li key={comment.id}>
              <div className="border-b border-kumo-line bg-kumo-base px-4 py-2 font-mono text-sm break-all">
                {comment.file}
              </div>
              {renderComment(comment)}
            </li>
          ))}
        </ol>
      ) : (
        [...groupComments(visible)].map(([file, threads]) => (
          <Collapsible.Root
            key={file}
            open={!collapsedPaths.has(file)}
            onOpenChange={() => onToggleCollapse(file)}
            className="mb-4"
          >
            <h2 className="border-y border-kumo-line bg-kumo-base">
              <Collapsible.Trigger
                render={<Button variant="ghost" className="h-auto w-full justify-start gap-2 rounded-none px-4 py-2 text-sm" />}
              >
                {collapsedPaths.has(file) ? <CaretRightIcon size={16} /> : <CaretDownIcon size={16} />}
                <span className="min-w-0 flex-1 text-left font-mono break-all">{file}</span>
                <Badge variant="outline">{threads.length}</Badge>
              </Collapsible.Trigger>
            </h2>
            <Collapsible.Panel>
              <div className="flex flex-col gap-2 px-4 py-3">
                {threads.map(renderComment)}
              </div>
            </Collapsible.Panel>
          </Collapsible.Root>
        ))
      )}
    </main>
  );
}

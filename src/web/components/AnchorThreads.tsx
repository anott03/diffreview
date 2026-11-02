import type { Comment } from "../../shared/types";
import type { CommentDraft } from "../comment-draft";
import { CommentEditor } from "./CommentEditor";
import { CommentThread } from "./CommentThread";

interface AnchorThreadsProps {
  comments: Comment[];
  draft: CommentDraft | null;
  error?: string | null;
  onDraftBodyChange: (body: string) => void;
  onCancelDraft: () => void;
  onSubmitDraft: (body: string) => Promise<boolean>;
  onResolve: (id: string) => void;
  onReopen: (id: string) => void;
  onDelete: (id: string) => void;
}

export function AnchorThreads({ comments, draft, error, onDraftBodyChange, onCancelDraft, onSubmitDraft, onResolve, onReopen, onDelete }: AnchorThreadsProps) {
  if (comments.length === 0 && !draft) return null;
  return (
    <div className="flex flex-col gap-px border-y border-kumo-line bg-kumo-base py-px font-sans text-sm text-kumo-default">
      {comments.map((comment) => (
        <CommentThread key={comment.id} comment={comment} onResolve={onResolve} onReopen={onReopen} onDelete={onDelete} />
      ))}
      {draft && error && <p role="alert" className="px-4 py-2">{error}</p>}
      {draft && <CommentEditor body={draft.body} onBodyChange={onDraftBodyChange} onSubmit={onSubmitDraft} onCancel={onCancelDraft} />}
    </div>
  );
}

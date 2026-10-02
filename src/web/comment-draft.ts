import type { CreateCommentRequest } from "../shared/types";

export interface CommentDraft extends Pick<CreateCommentRequest, "side" | "line" | "lineText" | "body"> {}

export interface RetainedCommentDraft {
  reviewId: string;
  file: string;
  draft: CommentDraft;
}

export function commentDraftKey(reviewId: string | null, file: string): string {
  return JSON.stringify([reviewId, file]);
}

export function updateCommentDraft(
  drafts: Map<string, RetainedCommentDraft>,
  reviewId: string,
  file: string,
  draft: CommentDraft | null,
  expectedDraft?: CommentDraft,
): Map<string, RetainedCommentDraft> {
  const key = commentDraftKey(reviewId, file);
  const existing = drafts.get(key);
  if (expectedDraft && existing?.draft !== expectedDraft) return drafts;
  if (!expectedDraft && existing) return drafts;
  const next = new Map(drafts);
  if (draft) next.set(key, { reviewId, file, draft });
  else next.delete(key);
  return next;
}

export function retainedDraftEditingKey(editingKey: string | null, drafts: ReadonlyMap<string, RetainedCommentDraft>): string | null {
  return editingKey !== null && drafts.has(editingKey) ? editingKey : null;
}

export async function submitCommentOnce(
  pendingSaves: Set<string>,
  request: CreateCommentRequest,
  save: (request: CreateCommentRequest) => Promise<void>,
  onPending: () => void,
): Promise<boolean> {
  const key = commentDraftKey(request.reviewId ?? null, request.file);
  if (pendingSaves.has(key)) {
    onPending();
    return false;
  }
  pendingSaves.add(key);
  try {
    await save(request);
    return true;
  } finally {
    pendingSaves.delete(key);
  }
}

export interface CommentDraftProps {
  draft: CommentDraft | null;
  onDraftChange: (draft: CommentDraft | null, expectedDraft?: CommentDraft) => void;
}

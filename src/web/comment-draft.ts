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

export interface CommentDraftProps {
  draft: CommentDraft | null;
  onDraftChange: (draft: CommentDraft | null, expectedDraft?: CommentDraft) => void;
}

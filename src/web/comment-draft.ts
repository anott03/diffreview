import type { CreateCommentRequest } from "../shared/types";

export interface CommentDraft extends Pick<CreateCommentRequest, "side" | "line" | "lineText" | "body"> {}

export interface CommentDraftProps {
  draft: CommentDraft | null;
  onDraftChange: (draft: CommentDraft | null) => void;
}

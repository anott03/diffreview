import type { Comment, CommentStatus } from "../shared/types";

export function filterComments(comments: Comment[], reviewId: string | null, fileMode: "changed" | "all" | "history", status: CommentStatus | "all") {
  if (fileMode === "history") return [];
  return comments.filter((comment) =>
    (fileMode === "all" || (comment.reviewId === reviewId && !comment.historical)) &&
    (status === "all" || comment.status === status)
  );
}

import type { Comment, CommentStatus } from "../shared/types";

export type CommentSort = "newest" | "oldest";
export type CommentGrouping = "file" | "list";

/** Global creation-time order, independent of file membership. */
export function sortComments(comments: Comment[], status: CommentStatus | "all", sort: CommentSort) {
  const visible = comments.filter((comment) => status === "all" || comment.status === status);
  visible.sort((a, b) => sort === "newest" ? b.createdAt - a.createdAt : a.createdAt - b.createdAt);
  return visible;
}

/** Preserve the incoming sort order within groups and by each group's first comment. */
export function groupComments(comments: Comment[]) {
  const groups = new Map<string, Comment[]>();
  for (const comment of comments) {
    const group = groups.get(comment.file) ?? [];
    group.push(comment);
    groups.set(comment.file, group);
  }
  return groups;
}

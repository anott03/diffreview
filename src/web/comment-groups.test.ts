import { describe, expect, it } from "vitest";
import type { Comment } from "../shared/types";
import { groupComments, sortComments } from "./comment-groups";

const comment = (id: string, file: string, createdAt: number, status: Comment["status"] = "open"): Comment => ({
  id, file, createdAt, updatedAt: createdAt, status,
  side: "new", line: 1, lineText: "code", body: "feedback", author: "user",
});

describe("comment group ordering", () => {
  const comments = [
    comment("a-old", "a.ts", 1),
    comment("b-old", "b.ts", 2),
    comment("b-new", "b.ts", 3),
    comment("a-addressed", "a.ts", 4, "addressed"),
  ];

  it("sorts groups and their comments by newest visible comment, ignoring filtered-out activity", () => {
    const groups = groupComments(sortComments(comments, "open", "newest"));
    expect([...groups.keys()]).toEqual(["b.ts", "a.ts"]);
    expect(groups.get("b.ts")!.map((c) => c.id)).toEqual(["b-new", "b-old"]);
    expect(groups.get("a.ts")!.map((c) => c.id)).toEqual(["a-old"]);
    expect(comments.map((c) => c.id)).toEqual(["a-old", "b-old", "b-new", "a-addressed"]);
  });

  it("can show oldest first, or include addressed comments in newest-first ordering", () => {
    const oldest = groupComments(sortComments(comments, "all", "oldest"));
    expect([...oldest.keys()]).toEqual(["a.ts", "b.ts"]);
    expect(oldest.get("a.ts")!.map((c) => c.id)).toEqual(["a-old", "a-addressed"]);
    const newest = groupComments(sortComments(comments, "all", "newest"));
    expect([...newest.keys()]).toEqual(["a.ts", "b.ts"]);
    expect(newest.get("a.ts")!.map((c) => c.id)).toEqual(["a-addressed", "a-old"]);
    expect(groupComments(sortComments([], "open", "newest")).size).toBe(0);
  });

  it("interleaves files in flat recency order rather than flattening file groups", () => {
    expect(sortComments(comments, "all", "newest").map((c) => c.id))
      .toEqual(["a-addressed", "b-new", "b-old", "a-old"]);
    expect(sortComments(comments, "open", "newest").map((c) => c.id))
      .toEqual(["b-new", "b-old", "a-old"]);
    expect(sortComments(comments, "all", "oldest").map((c) => c.id))
      .toEqual(["a-old", "b-old", "b-new", "a-addressed"]);
  });
});

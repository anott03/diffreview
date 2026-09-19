import { describe, expect, it } from "vitest";
import type { Comment } from "../shared/types";
import { filterComments } from "./comment-filter";

const comment = (id: string, status: Comment["status"], reviewId?: string, historical = false): Comment => ({
  id, file: "a.ts", createdAt: 1, updatedAt: 1, status, reviewId, historical,
  side: "new", line: 1, lineText: "code", body: "feedback", author: "user",
});

const comments = [
  comment("open", "open", "current"),
  comment("addressed", "addressed", "current"),
  comment("old-open", "open", "previous", true),
  comment("old-addressed", "addressed", "previous", true),
  comment("legacy", "open"),
];

const ids = (values: Comment[]) => values.map((value) => value.id);

describe("file comment filtering", () => {
  it("filters current-review inline comments by status", () => {
    expect(ids(filterComments(comments, "current", "changed", "open"))).toEqual(["open"]);
    expect(ids(filterComments(comments, "current", "changed", "addressed"))).toEqual(["addressed"]);
    expect(ids(filterComments(comments, "current", "changed", "all"))).toEqual(["open", "addressed"]);
  });

  it("includes historical and legacy file comments in All files with the same status filter", () => {
    expect(ids(filterComments(comments, "current", "all", "open"))).toEqual(["open", "old-open", "legacy"]);
    expect(ids(filterComments(comments, "current", "all", "addressed"))).toEqual(["addressed", "old-addressed"]);
    expect(filterComments(comments, "current", "all", "all")).toEqual(comments);
    expect(ids(comments)).toEqual(["open", "addressed", "old-open", "old-addressed", "legacy"]);
  });

  it("does not treat missing or historical review membership as a current inline anchor", () => {
    expect(filterComments(comments, null, "changed", "all")).toEqual([]);
    expect(filterComments([comment("historical", "open", "current", true)], "current", "changed", "all")).toEqual([]);
    expect(filterComments([], "current", "all", "all")).toEqual([]);
  });

  it("hides comments in commit history mode", () => {
    expect(filterComments(comments, "current", "history", "all")).toEqual([]);
    expect(filterComments(comments, "current", "history", "open")).toEqual([]);
  });
});

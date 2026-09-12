import { describe, expect, it } from "vitest";
import { contextFromDiff, contextFromHead } from "./comment-context";
import { parseGitDiff } from "./diff";

const anchor = { file: "a.txt", side: "new" as const, line: 2, lineText: "TWO" };

describe("comment code context", () => {
  it("captures the correct side without crossing hunk gaps", () => {
    const files = parseGitDiff(`diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
@@ -20,1 +20,1 @@
-other
+OTHER
`);
    expect(contextFromDiff(files, anchor)).toEqual({
      source: "snapshot", line: 2,
      lines: [{ line: 1, content: "one" }, { line: 2, content: "TWO" }, { line: 3, content: "three" }]
    });
    expect(contextFromDiff(files, { ...anchor, side: "old", lineText: "two" })?.lines)
      .toContainEqual({ line: 2, content: "two" });
    expect(contextFromDiff(files, { ...anchor, side: "old" })).toBeUndefined();
  });

  it("recovers only matching HEAD code and selects the nearest duplicate", () => {
    expect(contextFromHead("TWO\none\nthree\nTWO\nlast\n", { ...anchor, line: 5 })).toEqual({
      source: "head", line: 4,
      lines: [
        { line: 1, content: "TWO" }, { line: 2, content: "one" },
        { line: 3, content: "three" }, { line: 4, content: "TWO" }, { line: 5, content: "last" }
      ]
    });
    expect(contextFromHead("one\nchanged\nthree\n", anchor)).toBeUndefined();
    expect(contextFromHead("TWO\n\0", anchor)).toBeUndefined();
    expect(contextFromHead("one\n", { ...anchor, lineText: "" })).toBeUndefined();
  });
});

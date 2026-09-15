import { describe, expect, it } from "vitest";
import { parseGitDiff } from "../server/diff";
import type { DiffFile } from "../shared/types";
import { diffWithContext, textLines, validateDiffContent } from "./diff-context";

const original = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
const current = original.map((line, index) => index === 4 ? "replacement" : index === 19 ? "another replacement" : line).join("\n") + "\n";
const file = parseGitDiff(`diff --git a/file.txt b/file.txt
--- a/file.txt
+++ b/file.txt
@@ -4,3 +4,3 @@
 line 4
-line 5
+replacement
 line 6
@@ -19,3 +19,3 @@
 line 19
-line 20
+another replacement
 line 21
`)[0]!;

function contextLines(diff: DiffFile) {
  return diff.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.type === "context");
}

describe("expandable diff context", () => {
  it("offers gaps before, between and after hunks without fetching file contents", () => {
    const result = diffWithContext(file, null, new Set());
    expect([...result.gaps.values()]).toEqual([
      { id: 0, count: 3, expanded: false },
      { id: 1, count: 12, expanded: false },
      { id: 2, count: null, expanded: false },
    ]);
    expect(contextLines(result.file)).toHaveLength(4);
  });

  it("expands only the selected gap and preserves hunk metadata", () => {
    validateDiffContent(file, current, original.join("\n"));
    const result = diffWithContext(file, current, new Set([1]));
    expect(result.file.hunks[2]!.lines).toEqual(original.slice(6, 18).map((content, index) => ({
      type: "context", oldLine: index + 7, newLine: index + 7, content,
    })));
    expect(result.file.additions).toBe(file.additions);
    expect(result.file.deletions).toBe(file.deletions);
    expect([...result.gaps.values()].at(-1)).toEqual({ id: 2, count: 9, expanded: false });
    expect(diffWithContext(file, current, new Set()).file.hunks[2]!.lines).toEqual([]);
  });

  it("reconstructs both complete sides without duplicate or omitted lines", () => {
    const result = diffWithContext(file, current, new Set([0, 1, 2]));
    const lines = result.file.hunks.flatMap((hunk) => hunk.lines);
    expect(lines.filter((line) => line.newLine !== undefined).map((line) => line.content)).toEqual(textLines(current));
    expect(lines.filter((line) => line.oldLine !== undefined).map((line) => line.content)).toEqual(original);
  });

  it.each([
    { header: "@@ -2,0 +3,1 @@", changes: "+inserted", content: "one\ntwo\ninserted\nthree\n", base: "one\ntwo\nthree\n", old: [1, 2, 3], fresh: [1, 2, 3, 4] },
    { header: "@@ -3,1 +2,0 @@", changes: "-removed", content: "one\ntwo\nthree\n", base: "one\ntwo\nremoved\nthree\n", old: [1, 2, 3, 4], fresh: [1, 2, 3] },
    { header: "@@ -0,0 +1,1 @@", changes: "+inserted", content: "inserted\none\n", base: "one\n", old: [1], fresh: [1, 2] },
    { header: "@@ -1,1 +0,0 @@", changes: "-removed", content: "one\n", base: "removed\none\n", old: [1, 2], fresh: [1] },
  ])("keeps both line numbers correct for zero-context $header", ({ header, changes, content, base, old, fresh }) => {
    const file = parseGitDiff(`diff --git a/f b/f\n--- a/f\n+++ b/f\n${header}\n${changes}\n`)[0]!;
    validateDiffContent(file, content, base);
    const lines = diffWithContext(file, content, new Set([0, 1])).file.hunks.flatMap((hunk) => hunk.lines);
    expect(lines.flatMap((line) => line.oldLine ?? [])).toEqual(old);
    expect(lines.flatMap((line) => line.newLine ?? [])).toEqual(fresh);
  });

  it("can reveal a rename with no changed lines", () => {
    const renamed: DiffFile = { ...file, status: "renamed", hunks: [], oldPath: "old.txt", newPath: "new.txt", additions: 0, deletions: 0 };
    expect(contextLines(diffWithContext(renamed, "hello\n", new Set([0])).file)).toEqual([
      { type: "context", oldLine: 1, newLine: 1, content: "hello" },
    ]);
  });

  it("does not offer gaps for added, deleted or binary files", () => {
    for (const entry of [{ ...file, oldPath: null }, { ...file, newPath: null }, { ...file, isBinary: true, hunks: [] }]) {
      expect(diffWithContext(entry, null, new Set()).gaps.size).toBe(0);
    }
  });

  it("rejects hidden changes even when the visible hunks still match", () => {
    for (const stale of [current + "appended\n", current.replace("line 10", "hidden edit"), current.replace("line 10\n", "")]) {
      expect(() => validateDiffContent(file, stale, original.join("\n"))).toThrow("changed while loading");
    }
  });

  it("rejects stale content and enforces the display limit", () => {
    expect(() => validateDiffContent(file, current.replace("replacement", "stale"), original.join("\n"))).toThrow("changed while loading");
    expect(() => validateDiffContent(file, "line\n".repeat(10001), original.join("\n"))).toThrow("10,000-line");
    expect(textLines("")).toEqual([]);
    expect(textLines("\n")).toEqual([""]);
    expect(textLines("last line")).toEqual(["last line"]);
  });
});

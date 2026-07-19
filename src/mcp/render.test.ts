import { describe, expect, it } from "vitest";
import type { DiffFile } from "../shared/types";
import { renderUnifiedDiff } from "./render";

const files: DiffFile[] = [
  {
    oldPath: "a.ts",
    newPath: "a.ts",
    status: "modified",
    isBinary: false,
    additions: 1,
    deletions: 1,
    hunks: [
      {
        header: "@@ -1,2 +1,2 @@",
        oldStart: 1,
        newStart: 1,
        lines: [
          { type: "context", oldLine: 1, newLine: 1, content: "keep" },
          { type: "del", oldLine: 2, content: "old" },
          { type: "add", newLine: 2, content: "new" },
        ],
      },
    ],
  },
  {
    oldPath: null,
    newPath: "bin.dat",
    status: "added",
    isBinary: true,
    additions: 0,
    deletions: 0,
    hunks: [],
  },
];

describe("renderUnifiedDiff", () => {
  it("renders unified text with correct prefixes", () => {
    const out = renderUnifiedDiff(files, "a.ts");
    expect(out).toBe(`diff --git a/a.ts b/a.ts
@@ -1,2 +1,2 @@
 keep
-old
+new`);
  });

  it("renders binary placeholders", () => {
    const out = renderUnifiedDiff(files, "bin.dat");
    expect(out).toBe(`diff --git a/bin.dat b/bin.dat
new file
Binary files differ`);
  });

  it("renders all files when no filter is given", () => {
    expect(renderUnifiedDiff(files).split("\n")).toContain("diff --git a/bin.dat b/bin.dat");
  });

  it("returns empty string for an unknown file filter", () => {
    expect(renderUnifiedDiff(files, "nope.ts")).toBe("");
  });
});

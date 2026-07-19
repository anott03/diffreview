import { describe, expect, it } from "vitest";
import type { Comment, DiffFile } from "../shared/types";
import {
  buildUntrackedBinaryFile,
  buildUntrackedFile,
  parseGitDiff,
  resolveAnchors,
} from "./diff";

const SAMPLE_DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,4 @@
 line1
-line2
+line2 changed
 line3
 line4
diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
diff --git a/old.txt b/old.txt
deleted file mode 100644
index 4444444..0000000
--- a/old.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-bye
-now
diff --git a/oldname.ts b/newname.ts
similarity index 90%
rename from oldname.ts
rename to newname.ts
index 5555555..6666666 100644
--- a/oldname.ts
+++ b/newname.ts
@@ -1,2 +1,2 @@
 keep
-drop
+add
diff --git a/logo.png b/logo.png
index 7777777..8888888 100644
Binary files a/logo.png and b/logo.png differ
`;

describe("parseGitDiff", () => {
  const files = parseGitDiff(SAMPLE_DIFF);

  it("parses all files", () => {
    expect(files.map((f) => f.newPath ?? f.oldPath)).toEqual([
      "src/a.ts",
      "new.txt",
      "old.txt",
      "newname.ts",
      "logo.png",
    ]);
  });

  it("detects statuses", () => {
    expect(files.map((f) => f.status)).toEqual([
      "modified",
      "added",
      "deleted",
      "renamed",
      "modified",
    ]);
  });

  it("sets paths for added/deleted files", () => {
    const added = files[1]!;
    expect(added.oldPath).toBeNull();
    expect(added.newPath).toBe("new.txt");
    const deleted = files[2]!;
    expect(deleted.oldPath).toBe("old.txt");
    expect(deleted.newPath).toBeNull();
  });

  it("computes line numbers for a modified file", () => {
    const lines = files[0]!.hunks[0]!.lines;
    expect(lines).toEqual([
      { type: "context", oldLine: 1, newLine: 1, content: "line1" },
      { type: "del", oldLine: 2, content: "line2" },
      { type: "add", newLine: 2, content: "line2 changed" },
      { type: "context", oldLine: 3, newLine: 3, content: "line3" },
      { type: "context", oldLine: 4, newLine: 4, content: "line4" },
    ]);
    expect(files[0]!.additions).toBe(1);
    expect(files[0]!.deletions).toBe(1);
  });

  it("keeps the hunk header", () => {
    expect(files[0]!.hunks[0]!.header).toBe("@@ -1,4 +1,4 @@");
  });

  it("marks binary files", () => {
    const bin = files[4]!;
    expect(bin.isBinary).toBe(true);
    expect(bin.hunks).toHaveLength(0);
  });

  it("does not mark a pure rename as binary", () => {
    const renameOnly = parseGitDiff(`diff --git a/old.txt b/new.txt
similarity index 100%
rename from old.txt
rename to new.txt
`);
    expect(renameOnly).toHaveLength(1);
    expect(renameOnly[0]!.status).toBe("renamed");
    expect(renameOnly[0]!.isBinary).toBe(false);
  });

  it("returns an empty array for empty input", () => {
    expect(parseGitDiff("")).toEqual([]);
  });
});

describe("buildUntrackedFile", () => {
  it("builds an all-adds file", () => {
    const f = buildUntrackedFile("notes.md", "alpha\nbeta\n");
    expect(f.status).toBe("added");
    expect(f.isBinary).toBe(false);
    expect(f.additions).toBe(2);
    expect(f.hunks[0]!.lines).toEqual([
      { type: "add", newLine: 1, content: "alpha" },
      { type: "add", newLine: 2, content: "beta" },
    ]);
  });

  it("handles a missing trailing newline", () => {
    const f = buildUntrackedFile("a.txt", "one\ntwo");
    expect(f.additions).toBe(2);
  });

  it("handles an empty file", () => {
    const f = buildUntrackedFile("empty.txt", "");
    expect(f.additions).toBe(0);
    expect(f.hunks).toHaveLength(0);
  });

  it("builds binary placeholders", () => {
    const f = buildUntrackedBinaryFile("blob.bin");
    expect(f.isBinary).toBe(true);
    expect(f.hunks).toHaveLength(0);
  });
});

describe("resolveAnchors", () => {
  const makeFiles = (shifted: boolean): DiffFile[] => [
    {
      oldPath: "a.ts",
      newPath: "a.ts",
      status: "modified",
      isBinary: false,
      additions: 1,
      deletions: 0,
      hunks: [
        {
          header: "@@ -1,2 +1,3 @@",
          oldStart: 1,
          newStart: 1,
          lines: shifted
            ? [
                { type: "context", oldLine: 1, newLine: 1, content: "alpha" },
                { type: "add", newLine: 2, content: "inserted" },
                { type: "context", oldLine: 2, newLine: 3, content: "beta" },
                { type: "context", oldLine: 3, newLine: 4, content: "gamma" },
              ]
            : [
                { type: "context", oldLine: 1, newLine: 1, content: "alpha" },
                { type: "context", oldLine: 2, newLine: 2, content: "beta" },
                { type: "context", oldLine: 3, newLine: 3, content: "gamma" },
              ],
        },
      ],
    },
  ];

  const makeComment = (overrides: Partial<Comment> = {}): Comment => ({
    id: "c1",
    file: "a.ts",
    side: "new",
    line: 3,
    lineText: "gamma",
    body: "why?",
    author: "user",
    status: "open",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  });

  it("keeps exact anchors", () => {
    const [c] = resolveAnchors(makeFiles(false), [makeComment()]);
    expect(c!.outdated).toBe(false);
    expect(c!.line).toBe(3);
  });

  it("re-anchors by content when lines shift", () => {
    const [c] = resolveAnchors(makeFiles(true), [makeComment()]);
    expect(c!.outdated).toBe(false);
    expect(c!.line).toBe(4);
  });

  it("marks comments outdated when the line is gone", () => {
    const [c] = resolveAnchors(makeFiles(false), [makeComment({ lineText: "deleted content" })]);
    expect(c!.outdated).toBe(true);
    expect(c!.line).toBe(3);
  });

  it("marks comments outdated when the file is gone", () => {
    const [c] = resolveAnchors(makeFiles(false), [makeComment({ file: "other.ts" })]);
    expect(c!.outdated).toBe(true);
  });

  it("anchors on the old side for deleted lines", () => {
    const files: DiffFile[] = [
      {
        oldPath: "a.ts",
        newPath: "a.ts",
        status: "modified",
        isBinary: false,
        additions: 0,
        deletions: 1,
        hunks: [
          {
            header: "@@ -1,2 +1,1 @@",
            oldStart: 1,
            newStart: 1,
            lines: [
              { type: "del", oldLine: 5, content: "gone" },
              { type: "context", oldLine: 6, newLine: 1, content: "stays" },
            ],
          },
        ],
      },
    ];
    const [c] = resolveAnchors(files, [makeComment({ side: "old", line: 5, lineText: "gone" })]);
    expect(c!.outdated).toBe(false);
  });
});

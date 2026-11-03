import { describe, expect, it } from "vitest";
import type { Comment, DiffFile } from "../shared/types";
import {
  buildUntrackedBinaryFile,
  buildUntrackedFile,
  resolveAnchors,
} from "./diff";

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
    reviewId: "review-1",
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
    const [c] = resolveAnchors(makeFiles(false), [makeComment()], "review-1");
    expect(c!.outdated).toBe(false);
    expect(c!.line).toBe(3);
  });

  it("re-anchors by content when lines shift", () => {
    const [c] = resolveAnchors(makeFiles(true), [makeComment()], "review-1");
    expect(c!.outdated).toBe(false);
    expect(c!.line).toBe(4);
  });

  it("never re-anchors historical or unscoped comments, even when the same code reappears", () => {
    for (const status of ["open", "addressed"] as const) {
      const previous = makeComment({ reviewId: "previous-review", status });
      const { reviewId: _reviewId, ...legacy } = makeComment({ status });
      const resolved = resolveAnchors(makeFiles(true), [previous, legacy], "review-1");
      for (const comment of resolved) {
        expect(comment).toMatchObject({ historical: true, outdated: true, line: 3, status });
      }
      expect(resolved[1]!.reviewId).toBeUndefined();
    }
  });

  it("marks comments outdated when the line is gone", () => {
    const [c] = resolveAnchors(makeFiles(false), [makeComment({ lineText: "deleted content" })], "review-1");
    expect(c!.outdated).toBe(true);
    expect(c!.line).toBe(3);
  });

  it("marks comments outdated when the file is gone", () => {
    const [c] = resolveAnchors(makeFiles(false), [makeComment({ file: "other.ts" })], "review-1");
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
    const [c] = resolveAnchors(files, [makeComment({ side: "old", line: 5, lineText: "gone" })], "review-1");
    expect(c!.outdated).toBe(false);
  });
});

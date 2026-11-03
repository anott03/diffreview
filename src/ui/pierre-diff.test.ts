import { hydratePartialDiff } from "@pierre/diffs";
import { describe, expect, it } from "vitest";
import { textLines } from "../core/diff-context";
import { current, file, original, zeroContextCases, zeroContextFile } from "../core/test-fixtures/diff";
import type { DiffFile } from "../core/diff-model";
import { toFileDiffMetadata, type CompleteDiffContent } from "./pierre-diff";

function pierreLines(file: DiffFile, complete: CompleteDiffContent | null) {
  const metadata = toFileDiffMetadata(file, complete);
  const old: { line: number; text: string }[] = [];
  const fresh: { line: number; text: string }[] = [];
  if (complete) {
    metadata.deletionLines.forEach((text, index) => old.push({ line: index + 1, text: text.slice(0, -1) }));
    metadata.additionLines.forEach((text, index) => fresh.push({ line: index + 1, text: text.slice(0, -1) }));
  } else {
    for (const hunk of metadata.hunks) {
      let oldNumber = hunk.deletionStart;
      let newNumber = hunk.additionStart;
      for (const group of hunk.hunkContent) {
        const oldCount = group.type === "context" ? group.lines : group.deletions;
        const newCount = group.type === "context" ? group.lines : group.additions;
        for (let index = 0; index < oldCount; index++) old.push({ line: oldNumber++, text: metadata.deletionLines[group.deletionLineIndex + index]!.slice(0, -1) });
        for (let index = 0; index < newCount; index++) fresh.push({ line: newNumber++, text: metadata.additionLines[group.additionLineIndex + index]!.slice(0, -1) });
      }
    }
  }
  return { old, fresh };
}

describe("Pierre diff metadata", () => {
  it("renders partial hunks with stable cache keys", () => {
    const key = toFileDiffMetadata(file, null).cacheKey;
    expect(toFileDiffMetadata(structuredClone(file), null).cacheKey).toBe(key);
    expect(toFileDiffMetadata({ ...file, newPath: "different.txt" }, null).cacheKey).not.toBe(key);
    expect(toFileDiffMetadata({ ...file, hunks: file.hunks.map((hunk) => ({
      ...hunk, oldStart: hunk.oldStart + 1,
      lines: hunk.lines.map((line) => ({ ...line, oldLine: line.oldLine === undefined ? undefined : line.oldLine + 1 })),
    })) }, null).cacheKey).not.toBe(key);
    expect(toFileDiffMetadata({ ...file, hunks: file.hunks.map((hunk) => ({
      ...hunk, lines: hunk.lines.map((line) => ({ ...line, content: line.content.replace("replacement", "replacemenT") })),
    })) }, null).cacheKey).not.toBe(key);
    const rendered = pierreLines(file, null);
    for (const [side, lines] of [["oldLine", rendered.old], ["newLine", rendered.fresh]] as const) {
      expect(lines).toEqual(file.hunks.flatMap((hunk) => hunk.lines.flatMap((line) =>
        line[side] === undefined ? [] : [{ line: line[side], text: line.content }])));
    }
  });

  it("renders both complete sides and binds hydrated keys to full contents", () => {
    const complete = { content: current, baseContent: original.join("\n") };
    const full = toFileDiffMetadata(file, complete);
    expect(toFileDiffMetadata(structuredClone(file), { ...complete }).cacheKey).toBe(full.cacheKey);
    expect(full.cacheKey).not.toBe(toFileDiffMetadata(file, null).cacheKey);
    const differentBase = { ...complete, baseContent: complete.baseContent.replace("line 10", "line 1x") };
    const differentNew = { ...complete, content: complete.content.replace("line 10", "line 1x") };
    expect(toFileDiffMetadata(file, differentBase).cacheKey).not.toBe(full.cacheKey);
    expect(toFileDiffMetadata(file, differentNew).cacheKey).not.toBe(full.cacheKey);
    const hydratedKeys = [complete, differentBase, differentNew].map((contents) => {
      const partial = toFileDiffMetadata(file, null);
      const metadata = toFileDiffMetadata(file, contents);
      partial.cacheKey = `${metadata.cacheKey}:hydrating`;
      return hydratePartialDiff("merge", partial, {
        oldFile: { name: "file.txt", contents: contents.baseContent },
        newFile: { name: "file.txt", contents: contents.content },
      }).cacheKey;
    });
    expect(new Set(hydratedKeys).size).toBe(3);
    expect(hydratedKeys).not.toContain(full.cacheKey);
    expect(hydratedKeys).not.toContain(toFileDiffMetadata(file, null).cacheKey);
    const rendered = pierreLines(file, complete);
    expect(rendered.old).toEqual(original.map((text, index) => ({ line: index + 1, text })));
    expect(rendered.fresh).toEqual(textLines(current).map((text, index) => ({ line: index + 1, text })));
  });

  it.each(zeroContextCases)("keeps both line numbers correct for zero-context $header", ({ header, changes, content, base, old, fresh }) => {
    const rendered = pierreLines(zeroContextFile(header, changes), { content, baseContent: base });
    expect(rendered.old.map((line) => line.line)).toEqual(old);
    expect(rendered.fresh.map((line) => line.line)).toEqual(fresh);
  });

  it("can reveal a rename with no changed lines", () => {
    const renamed: DiffFile = { ...file, status: "renamed", hunks: [], oldPath: "old.txt", newPath: "new.txt", additions: 0, deletions: 0 };
    expect(pierreLines(renamed, { content: "hello\n", baseContent: "hello\n" })).toEqual({
      old: [{ line: 1, text: "hello" }], fresh: [{ line: 1, text: "hello" }],
    });
  });
});

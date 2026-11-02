import type { ChangeContent, ContextContent, FileDiffMetadata, Hunk } from "@pierre/diffs";
import type { CommentSide, DiffFile, DiffHunk, DiffLine } from "../shared/types";
import { textLines } from "./diff-context";

export const DIFF_THEMES = { light: "github-light", dark: "github-dark" } as const;

export function anchorKey(side: CommentSide, line: number): string {
  return `${side}:${line}`;
}

export interface CompleteDiffContent {
  content: string;
  baseContent: string;
}

const CHANGE_TYPES = {
  added: "new",
  deleted: "deleted",
  modified: "change",
} as const;

function sideStartBoundary(start: number, count: number): number {
  return start - (count === 0 ? 0 : 1);
}

function contentGroups(lines: DiffLine[], deletionIndex: number, additionIndex: number): (ContextContent | ChangeContent)[] {
  const groups: (ContextContent | ChangeContent)[] = [];
  let current: ContextContent | ChangeContent | undefined;
  for (const line of lines) {
    if (line.type === "context") {
      if (current?.type !== "context") {
        current = { type: "context", lines: 0, deletionLineIndex: deletionIndex, additionLineIndex: additionIndex };
        groups.push(current);
      }
      current.lines++;
      deletionIndex++;
      additionIndex++;
      continue;
    }
    if (current?.type !== "change") {
      current = { type: "change", deletions: 0, additions: 0, deletionLineIndex: deletionIndex, additionLineIndex: additionIndex };
      groups.push(current);
    }
    if (line.type === "del") {
      current.deletions++;
      deletionIndex++;
    } else {
      current.additions++;
      additionIndex++;
    }
  }
  return groups;
}

/**
 * Converts server-parsed hunks into Pierre metadata without recomputing the diff.
 * With complete contents, the same hunks index into the full files so unchanged
 * lines can be rendered.
 */
export function toFileDiffMetadata(file: DiffFile, complete: CompleteDiffContent | null): FileDiffMetadata {
  const partial = complete === null;
  const deletionLines: string[] = partial ? [] : textLines(complete.baseContent).map((line) => `${line}\n`);
  const additionLines: string[] = partial ? [] : textLines(complete.content).map((line) => `${line}\n`);
  const hunks: Hunk[] = [];
  let splitLineCount = 0;
  let unifiedLineCount = 0;
  let lastHunkEnd = 0;

  const sourceHunks: DiffHunk[] = file.hunks.length === 0 && complete && file.oldPath && file.newPath
    ? [{
      header: "Unchanged code", oldStart: 1, newStart: 1,
      lines: textLines(complete.content).map((content, index) => ({
        type: "context", oldLine: index + 1, newLine: index + 1, content,
      })),
    }]
    : file.hunks;

  for (const hunk of sourceHunks) {
    const deletionCount = hunk.lines.filter((line) => line.oldLine !== undefined).length;
    const additionCount = hunk.lines.filter((line) => line.newLine !== undefined).length;
    const deletionStart = hunk.lines.find((line) => line.oldLine !== undefined)?.oldLine ?? hunk.oldStart;
    const additionStart = hunk.lines.find((line) => line.newLine !== undefined)?.newLine ?? hunk.newStart;
    const deletionLineIndex = partial ? deletionLines.length : sideStartBoundary(deletionStart, deletionCount);
    const additionLineIndex = partial ? additionLines.length : sideStartBoundary(additionStart, additionCount);
    if (partial) {
      for (const line of hunk.lines) {
        if (line.oldLine !== undefined) deletionLines.push(`${line.content}\n`);
        if (line.newLine !== undefined) additionLines.push(`${line.content}\n`);
      }
    }
    const hunkContent = contentGroups(hunk.lines, deletionLineIndex, additionLineIndex);
    let hunkSplit = 0;
    let hunkUnified = 0;
    for (const content of hunkContent) {
      if (content.type === "context") {
        hunkSplit += content.lines;
        hunkUnified += content.lines;
      } else {
        hunkSplit += Math.max(content.additions, content.deletions);
        hunkUnified += content.additions + content.deletions;
      }
    }
    const collapsedBefore = Math.max(sideStartBoundary(additionStart, additionCount) - lastHunkEnd, 0);
    hunks.push({
      collapsedBefore,
      additionStart,
      additionCount,
      additionLines: hunk.lines.filter((line) => line.type === "add").length,
      additionLineIndex,
      deletionStart,
      deletionCount,
      deletionLines: hunk.lines.filter((line) => line.type === "del").length,
      deletionLineIndex,
      hunkContent,
      hunkSpecs: hunk.header,
      splitLineStart: splitLineCount + collapsedBefore,
      splitLineCount: hunkSplit,
      unifiedLineStart: unifiedLineCount + collapsedBefore,
      unifiedLineCount: hunkUnified,
      noEOFCRDeletions: false,
      noEOFCRAdditions: false,
    });
    splitLineCount += collapsedBefore + hunkSplit;
    unifiedLineCount += collapsedBefore + hunkUnified;
    lastHunkEnd = sideStartBoundary(additionStart, additionCount) + additionCount;
  }
  if (!partial && hunks.length > 0) {
    const collapsedAfter = Math.max(additionLines.length - lastHunkEnd, 0);
    splitLineCount += collapsedAfter;
    unifiedLineCount += collapsedAfter;
  }

  const name = file.newPath ?? file.oldPath ?? "";
  const metadata: FileDiffMetadata = {
    name,
    type: file.status === "renamed" ? (file.hunks.length > 0 ? "rename-changed" : "rename-pure") : CHANGE_TYPES[file.status],
    hunks,
    splitLineCount,
    unifiedLineCount,
    isPartial: partial,
    deletionLines,
    additionLines,
    deletionCharacterCount: deletionLines.reduce((total, line) => total + line.length, 0),
    additionCharacterCount: additionLines.reduce((total, line) => total + line.length, 0),
    cacheKey: `diffreview:${crypto.randomUUID()}`,
  };
  if (file.status === "renamed" && file.oldPath) metadata.prevName = file.oldPath;
  return metadata;
}

export function visibleDiffLines(file: DiffFile): Map<string, string> {
  const visible = new Map<string, string>();
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.oldLine !== undefined) visible.set(anchorKey("old", line.oldLine), line.content);
      if (line.newLine !== undefined) visible.set(anchorKey("new", line.newLine), line.content);
    }
  }
  return visible;
}

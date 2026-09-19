import type { DiffFile, DiffHunk, DiffLine } from "../shared/types";

export interface ContextGap {
  id: number;
  count: number | null;
  expanded: boolean;
}

export function textLines(content: string): string[] {
  const lines = content ? content.split("\n") : [];
  if (content.endsWith("\n")) lines.pop();
  return lines;
}

export function validateDiffContent(file: DiffFile, content: string, baseContent: string): void {
  const lines = textLines(content);
  const base = textLines(baseContent);
  if (lines.length > 10000 || base.length > 10000) throw new Error("Unchanged code exceeds the 10,000-line display limit.");
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.newLine !== undefined && lines[line.newLine - 1] !== line.content) {
        throw new Error("This file changed while loading. Refresh the diff and try again.");
      }
    }
  }
  const expanded = diffWithContext(file, content, new Set(Array.from({ length: file.hunks.length + 1 }, (_, index) => index)));
  const complete = expanded.file.hunks.flatMap((hunk) => hunk.lines);
  const oldLines = complete.filter((line) => line.oldLine !== undefined);
  const newLines = complete.filter((line) => line.newLine !== undefined);
  if (oldLines.length !== base.length || newLines.length !== lines.length
    || oldLines.some((line, index) => line.oldLine !== index + 1 || line.content !== base[index])
    || newLines.some((line, index) => line.newLine !== index + 1 || line.content !== lines[index])) {
    throw new Error("This file changed while loading. Refresh the diff and try again.");
  }
}

export function diffWithContext(file: DiffFile, content: string | null, expanded: Set<number>) {
  const text = content === null ? null : textLines(content);
  const hunks: DiffHunk[] = [];
  const gaps = new Map<number, ContextGap>();
  let oldCursor = 1;
  let newCursor = 1;

  const addGap = (id: number, count: number | null) => {
    if (count === 0) return;
    const open = expanded.has(id) && text !== null;
    const lines: DiffLine[] = open
      ? text.slice(newCursor - 1, newCursor - 1 + (count ?? 0)).map((content, offset) => ({
        type: "context", oldLine: oldCursor + offset, newLine: newCursor + offset, content,
      })) : [];
    gaps.set(hunks.length, { id, count, expanded: open });
    hunks.push({ header: "Unchanged code", oldStart: oldCursor, newStart: newCursor, lines });
  };

  for (const [index, hunk] of file.hunks.entries()) {
    const oldStart = hunk.lines.find((line) => line.oldLine !== undefined)?.oldLine ?? hunk.oldStart + 1;
    const newStart = hunk.lines.find((line) => line.newLine !== undefined)?.newLine ?? hunk.newStart + 1;
    const count = Math.max(0, Math.min(oldStart - oldCursor, newStart - newCursor));
    if (file.oldPath && file.newPath) addGap(index, count);
    hunks.push(hunk);
    oldCursor = oldStart + hunk.lines.filter((line) => line.oldLine !== undefined).length;
    newCursor = newStart + hunk.lines.filter((line) => line.newLine !== undefined).length;
  }
  if (file.oldPath && file.newPath && !file.isBinary) {
    addGap(file.hunks.length, text === null ? null : Math.max(0, text.length - newCursor + 1));
  }
  return { file: { ...file, hunks }, gaps };
}

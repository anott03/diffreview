import type { Comment, CommentContext, DiffFile } from "../shared/types";
import { diffFilePath } from "../shared/types";

type Anchor = Pick<Comment, "file" | "side" | "line" | "lineText">;
const CONTEXT_LINES = 3;

function excerpt(
  lines: CommentContext["lines"],
  anchor: Anchor,
  source: CommentContext["source"],
): CommentContext | undefined {
  // Prefer the nearest content match; never show unrelated code at a stale number.
  let index = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.content !== anchor.lineText) continue;
    if (index < 0 || Math.abs(lines[i]!.line - anchor.line) < Math.abs(lines[index]!.line - anchor.line)) {
      index = i;
    }
  }
  if (index < 0) return undefined;
  return {
    source,
    line: lines[index]!.line,
    lines: lines.slice(Math.max(0, index - CONTEXT_LINES), index + CONTEXT_LINES + 1),
  };
}

export function contextFromDiff(files: DiffFile[], anchor: Anchor): CommentContext | undefined {
  const file = files.find((file) => diffFilePath(file) === anchor.file);
  if (!file) return undefined;
  // Keep each excerpt within one hunk so omitted lines aren't presented as adjacent.
  const hunks = file.hunks.map((hunk) => hunk.lines.flatMap((entry) => {
    const line = anchor.side === "old" ? entry.oldLine : entry.newLine;
    return line === undefined ? [] : [{ line, content: entry.content }];
  }));
  const candidates = hunks.flatMap((lines) => {
    const context = excerpt(lines, anchor, "snapshot");
    return context ? [context] : [];
  });
  return candidates.sort((a, b) => Math.abs(a.line - anchor.line) - Math.abs(b.line - anchor.line))[0];
}

export function contextFromHead(text: string, anchor: Anchor): CommentContext | undefined {
  if (text.includes("\0")) return undefined;
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return excerpt(lines.map((content, i) => ({ line: i + 1, content })), anchor, "head");
}

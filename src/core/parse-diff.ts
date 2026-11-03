import parseDiff from "parse-diff";
import type { DiffFile, DiffHunk, DiffLine } from "./diff-model";

const BINARY_RE = /^Binary files a\/.+? and b\/(.+?) differ$/gm;

export function parseGitDiff(diffText: string): DiffFile[] {
  const binaryPaths = new Set<string>();
  for (const match of diffText.matchAll(BINARY_RE)) {
    binaryPaths.add(match[1]!);
  }

  return parseDiff(diffText).map((raw): DiffFile => {
    const oldPath = !raw.from || raw.from === "/dev/null" ? null : raw.from;
    const newPath = !raw.to || raw.to === "/dev/null" ? null : raw.to;

    let status: DiffFile["status"];
    if (raw.new) {
      status = "added";
    } else if (raw.deleted) {
      status = "deleted";
    } else if (oldPath !== null && newPath !== null && oldPath !== newPath) {
      status = "renamed";
    } else {
      status = "modified";
    }

    const hunks: DiffHunk[] = raw.chunks.map((chunk) => ({
      header: chunk.content,
      oldStart: chunk.oldStart,
      newStart: chunk.newStart,
      lines: chunk.changes
        .flatMap((change, index): DiffLine[] => {
          if (change.content.startsWith("\\")) return [];
          const mode = change.type === "del" ? raw.oldMode : raw.newMode;
          const noNewline = chunk.changes[index + 1]?.content.startsWith("\\");
          const text = change.content.slice(1);
          const content = mode !== "120000" && !noNewline && text.endsWith("\r") ? text.slice(0, -1) : text;
          if (change.type === "add") return [{ type: "add", newLine: change.ln, content }];
          if (change.type === "del") return [{ type: "del", oldLine: change.ln, content }];
          return [{ type: "context", oldLine: change.ln1, newLine: change.ln2, content }];
        }),
    }));

    const path = newPath ?? oldPath ?? "";
    const isBinary =
      binaryPaths.has(path) ||
      (hunks.length === 0 &&
        !raw.new &&
        !raw.deleted &&
        status !== "renamed" &&
        raw.additions === 0 &&
        raw.deletions === 0);

    return {
      oldPath,
      newPath,
      status,
      isBinary,
      hunks,
      additions: raw.additions,
      deletions: raw.deletions,
    };
  });
}

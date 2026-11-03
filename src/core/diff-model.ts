export type DiffLineType = "add" | "del" | "context";

export interface DiffLine {
  type: DiffLineType;
  /** Line number in the old file (1-based). Present for "del" and "context" lines. */
  oldLine?: number;
  /** Line number in the new file (1-based). Present for "add" and "context" lines. */
  newLine?: number;
  /** Line content without the leading +/-/space marker. */
  content: string;
}

export interface DiffHunk {
  /** Raw hunk header, e.g. "@@ -10,6 +10,7 @@ function foo() {". */
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export type DiffFileStatus = "added" | "modified" | "deleted" | "renamed";

export interface DiffFile {
  /** Path in the old tree (repo-relative). Null for added files. */
  oldPath: string | null;
  /** Path in the new tree (repo-relative). Null for deleted files. */
  newPath: string | null;
  status: DiffFileStatus;
  isBinary: boolean;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

export type DiffSide = "old" | "new";

/** Canonical display/anchor path for a diff file. */
export function diffFilePath(file: DiffFile): string {
  return file.newPath ?? file.oldPath ?? "";
}

export function anchorKey(side: DiffSide, line: number): string {
  return `${side}:${line}`;
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

import parseDiff from "parse-diff";
import type { Comment, DiffFile, DiffHunk, DiffLine } from "../shared/types";
import { diffFilePath } from "../shared/types";

// ---------------------------------------------------------------------------
// Raw parse-diff shapes (local narrowing; parse-diff's own types are loose)
// ---------------------------------------------------------------------------

interface RawChange {
  type: string;
  ln?: number;
  ln1?: number;
  ln2?: number;
  content: string;
}

interface RawChunk {
  content: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  changes: RawChange[];
}

interface RawFile {
  chunks: RawChunk[];
  additions: number;
  deletions: number;
  from?: string;
  to?: string;
  new?: boolean;
  deleted?: boolean;
}

const parse = parseDiff as unknown as (input: string) => RawFile[];

// ---------------------------------------------------------------------------
// Unified diff text -> DiffFile[]
// ---------------------------------------------------------------------------

const BINARY_RE = /^Binary files a\/.+? and b\/(.+?) differ$/gm;

export function parseGitDiff(diffText: string): DiffFile[] {
  const binaryPaths = new Set<string>();
  for (const match of diffText.matchAll(BINARY_RE)) {
    binaryPaths.add(match[1]!);
  }

  return parse(diffText).map((raw): DiffFile => {
    const oldPath = !raw.from || raw.from === "/dev/null" ? null : raw.from;
    const newPath = !raw.to || raw.to === "/dev/null" ? null : raw.to;

    const status: DiffFile["status"] = raw.new
      ? "added"
      : raw.deleted
        ? "deleted"
        : oldPath !== null && newPath !== null && oldPath !== newPath
          ? "renamed"
          : "modified";

    const hunks: DiffHunk[] = raw.chunks.map((chunk) => ({
      header: chunk.content,
      oldStart: chunk.oldStart,
      newStart: chunk.newStart,
      lines: chunk.changes
        // parse-diff emits "\ No newline at end of file" as a duplicated change
        // entry — drop those meta lines.
        .filter((change) => !change.content.startsWith("\\"))
        .map((change): DiffLine => {
          const content = change.content.slice(1);
          if (change.type === "add") return { type: "add", newLine: change.ln, content };
          if (change.type === "del") return { type: "del", oldLine: change.ln, content };
          return { type: "context", oldLine: change.ln1, newLine: change.ln2, content };
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

// ---------------------------------------------------------------------------
// Untracked files (git diff never includes them — built directly, no text
// round-trip, so paths with spaces etc. are never mis-parsed)
// ---------------------------------------------------------------------------

export function buildUntrackedFile(path: string, content: string): DiffFile {
  const parts = content.length > 0 ? content.split("\n") : [];
  // A trailing newline produces an empty final element — drop it.
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();

  const lines: DiffLine[] = parts.map((text, i) => ({
    type: "add",
    newLine: i + 1,
    content: text,
  }));

  return {
    oldPath: null,
    newPath: path,
    status: "added",
    isBinary: false,
    hunks:
      lines.length > 0
        ? [{ header: `@@ -0,0 +1,${lines.length} @@`, oldStart: 0, newStart: 1, lines }]
        : [],
    additions: lines.length,
    deletions: 0,
  };
}

export function buildUntrackedBinaryFile(path: string): DiffFile {
  return {
    oldPath: null,
    newPath: path,
    status: "added",
    isBinary: true,
    hunks: [],
    additions: 0,
    deletions: 0,
  };
}

// ---------------------------------------------------------------------------
// Comment anchor resolution
// ---------------------------------------------------------------------------

/**
 * Reconciles stored comment anchors against the current diff. Anchoring is
 * content-aware:
 *
 * - Anchor line present at the same position with identical content → kept.
 * - Line moved, or content at the anchor changed but the original content
 *   exists elsewhere on the same side → re-anchored to the nearest match.
 * - Original content gone (line edited away or file left the diff) →
 *   `outdated: true`; line left at last known position.
 *
 * Pure: returns new comment objects; the caller persists re-anchored lines.
 */
export function resolveAnchors(files: DiffFile[], comments: Comment[]): Comment[] {
  return comments.map((comment) => {
    const file = files.find((f) => diffFilePath(f) === comment.file);
    if (!file) return { ...comment, outdated: true };

    const lines = file.hunks.flatMap((h) => h.lines);
    const lineOf = (l: DiffLine): number | undefined =>
      comment.side === "new" ? l.newLine : l.oldLine;

    const atAnchor = lines.find((l) => lineOf(l) === comment.line);
    if (atAnchor && atAnchor.content === comment.lineText) {
      return { ...comment, outdated: false };
    }

    const candidates = lines
      .filter((l) => lineOf(l) !== undefined && l.content === comment.lineText)
      .map((l) => lineOf(l)!)
      .sort((a, b) => Math.abs(a - comment.line) - Math.abs(b - comment.line));

    if (candidates.length === 0) return { ...comment, outdated: true };
    return { ...comment, line: candidates[0]!, outdated: false };
  });
}

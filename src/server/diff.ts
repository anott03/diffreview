import type { Comment, DiffFile, DiffLine } from "../shared/types";
import { diffFilePath } from "../shared/types";

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
 * review-scoped and content-aware:
 *
 * - Missing/different review membership → historical; never re-anchor.
 * - Anchor line present at the same position with identical content → kept.
 * - Line moved, or content at the anchor changed but the original content
 *   exists elsewhere on the same side → re-anchored to the nearest match.
 * - Original content gone (line edited away or file left the diff) →
 *   `outdated: true`; line left at last known position.
 *
 * Pure: returns new comment objects; the caller persists re-anchored lines.
 */
export function resolveAnchors(files: DiffFile[], comments: Comment[], reviewId: string): Comment[] {
  return comments.map((stored) => {
    if (!stored.reviewId || stored.reviewId !== reviewId) {
      return { ...stored, historical: true, outdated: true };
    }
    const comment = { ...stored, historical: false };
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

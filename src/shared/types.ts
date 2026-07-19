/**
 * Shared type contracts for diffreview.
 *
 * Used by all three parts of the system:
 * - src/server/  (produces diff data, owns the comment store)
 * - src/web/     (renders diffs and comments)
 * - src/mcp/     (consumes the REST API on behalf of agents)
 */

// ---------------------------------------------------------------------------
// Diff model
// ---------------------------------------------------------------------------

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

/** Canonical display/anchor path for a diff file. */
export function diffFilePath(file: DiffFile): string {
  return file.newPath ?? file.oldPath ?? "";
}

// ---------------------------------------------------------------------------
// Comment model
// ---------------------------------------------------------------------------

export type CommentSide = "old" | "new";
export type CommentStatus = "open" | "addressed";
export type CommentAuthor = "user" | "agent";

export interface Comment {
  id: string;
  /** Canonical file path the comment is anchored to (see diffFilePath). */
  file: string;
  /** Which side of the diff the anchor line is on. */
  side: CommentSide;
  /** Line number on the given side (1-based). */
  line: number;
  /**
   * Content of the anchored line at comment time. Used to re-anchor the
   * comment when the diff shifts, and to detect staleness.
   */
  lineText: string;
  body: string;
  author: CommentAuthor;
  status: CommentStatus;
  /** Optional note, typically set by an agent when marking addressed. */
  note?: string;
  /**
   * Computed at read time (never stored): true when the anchor line can no
   * longer be located in the current diff.
   */
  outdated?: boolean;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Repo metadata
// ---------------------------------------------------------------------------

export interface Meta {
  repoRoot: string;
  branch: string;
  head: string;
  files: number;
  additions: number;
  deletions: number;
}

// ---------------------------------------------------------------------------
// REST API contracts
// ---------------------------------------------------------------------------

export interface GetDiffResponse {
  files: DiffFile[];
}

export interface ListCommentsResponse {
  comments: Comment[];
}

export interface CreateCommentRequest {
  file: string;
  side: CommentSide;
  line: number;
  lineText: string;
  body: string;
}

export interface UpdateCommentRequest {
  status?: CommentStatus;
  note?: string;
  body?: string;
}

export interface ApiErrorResponse {
  error: string;
}

// ---------------------------------------------------------------------------
// Server-sent events
// ---------------------------------------------------------------------------

/**
 * SSE messages are lightweight invalidation signals — clients refetch the
 * corresponding resource (/api/diff or /api/comments) on receipt.
 */
export type SseEventType = "diff" | "comments";

export interface SseEvent {
  type: SseEventType;
  /** Millisecond timestamp of the change (ordering/debugging only). */
  at: number;
}

// ---------------------------------------------------------------------------
// MCP discovery session file
// ---------------------------------------------------------------------------

/**
 * Written by the server to ~/.local/share/diff-review/sessions/<hash>.json,
 * read by diffreview-mcp to discover the running instance for a repo.
 */
export interface SessionInfo {
  port: number;
  pid: number;
  repoRoot: string;
  startedAt: number;
}

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Comment, CommentAuthor, CommentSide, CommentStatus } from "../shared/types";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  file TEXT NOT NULL,
  side TEXT NOT NULL CHECK(side IN ('old','new')),
  line INTEGER NOT NULL,
  line_text TEXT NOT NULL,
  body TEXT NOT NULL,
  author TEXT NOT NULL CHECK(author IN ('user','agent')),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','addressed')),
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_status ON comments(status);
`;

interface CommentRow {
  id: string;
  file: string;
  side: string;
  line: number;
  line_text: string;
  body: string;
  author: string;
  status: string;
  note: string | null;
  created_at: number;
  updated_at: number;
}

function rowToComment(row: CommentRow): Comment {
  return {
    id: row.id,
    file: row.file,
    side: row.side as CommentSide,
    line: row.line,
    lineText: row.line_text,
    body: row.body,
    author: row.author as CommentAuthor,
    status: row.status as CommentStatus,
    ...(row.note !== null ? { note: row.note } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateCommentInput {
  file: string;
  side: CommentSide;
  line: number;
  lineText: string;
  body: string;
  author: CommentAuthor;
}

export interface UpdateCommentInput {
  status?: CommentStatus;
  note?: string;
  body?: string;
  line?: number;
}

export interface CommentFilter {
  status?: CommentStatus;
  file?: string;
}

/**
 * Per-repo comment store. The HTTP server is the single writer; the MCP
 * server reaches it over HTTP, so SQLite only ever sees one process.
 */
export class CommentStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
  }

  list(filter: CommentFilter = {}): Comment[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    if (filter.file) {
      clauses.push("file = ?");
      params.push(filter.file);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM comments${where} ORDER BY created_at ASC`)
      .all(...params) as unknown as CommentRow[];
    return rows.map(rowToComment);
  }

  get(id: string): Comment | null {
    const row = this.db.prepare("SELECT * FROM comments WHERE id = ?").get(id) as unknown as
      | CommentRow
      | undefined;
    return row ? rowToComment(row) : null;
  }

  create(input: CreateCommentInput): Comment {
    const now = Date.now();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO comments (id, file, side, line, line_text, body, author, status, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?, ?)`,
      )
      .run(id, input.file, input.side, input.line, input.lineText, input.body, input.author, now, now);
    return this.get(id)!;
  }

  update(id: string, patch: UpdateCommentInput): Comment | null {
    const existing = this.get(id);
    if (!existing) return null;

    const sets: string[] = [];
    const params: (string | number)[] = [];
    if (patch.status !== undefined) {
      sets.push("status = ?");
      params.push(patch.status);
    }
    if (patch.note !== undefined) {
      sets.push("note = ?");
      params.push(patch.note);
    }
    if (patch.body !== undefined) {
      sets.push("body = ?");
      params.push(patch.body);
    }
    if (patch.line !== undefined) {
      sets.push("line = ?");
      params.push(patch.line);
    }
    if (sets.length === 0) return existing;

    sets.push("updated_at = ?");
    params.push(Date.now(), id);
    this.db.prepare(`UPDATE comments SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    return this.get(id);
  }

  remove(id: string): boolean {
    const result = this.db.prepare("DELETE FROM comments WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  close(): void {
    this.db.close();
  }
}

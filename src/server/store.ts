/**
 * Comment persistence.
 *
 * Per-repo SQLite store. The HTTP server is the single writer; the MCP
 * server reaches it over HTTP, so SQLite only ever sees one process.
 *
 * The sync core functions hold the SQL + row mapping; `CommentStore` is the
 * Effect service (`Effect<_, StoreError>` methods, layer with acquireRelease
 * lifecycle replacing the manual `close()`).
 */
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
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

// ---------------------------------------------------------------------------
// Sync core — shared by both implementations
// ---------------------------------------------------------------------------

function openDatabaseSync(dbPath: string): DatabaseSync {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  return db;
}

function listComments(db: DatabaseSync, filter: CommentFilter = {}): Comment[] {
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
  const rows = db
    .prepare(`SELECT * FROM comments${where} ORDER BY created_at ASC`)
    .all(...params) as unknown as CommentRow[];
  return rows.map(rowToComment);
}

function getComment(db: DatabaseSync, id: string): Comment | null {
  const row = db.prepare("SELECT * FROM comments WHERE id = ?").get(id) as unknown as
    | CommentRow
    | undefined;
  return row ? rowToComment(row) : null;
}

function insertComment(db: DatabaseSync, input: CreateCommentInput): Comment {
  const now = Date.now();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO comments (id, file, side, line, line_text, body, author, status, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?, ?)`,
  ).run(id, input.file, input.side, input.line, input.lineText, input.body, input.author, now, now);
  return getComment(db, id)!;
}

function updateComment(db: DatabaseSync, id: string, patch: UpdateCommentInput): Comment | null {
  const existing = getComment(db, id);
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
  db.prepare(`UPDATE comments SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return getComment(db, id);
}

function removeComment(db: DatabaseSync, id: string): boolean {
  const result = db.prepare("DELETE FROM comments WHERE id = ?").run(id);
  return Number(result.changes) > 0;
}

// ---------------------------------------------------------------------------
// Effect service
// ---------------------------------------------------------------------------

export class StoreError extends Schema.TaggedError<StoreError>()("StoreError", {
  op: Schema.Literals(["open", "list", "get", "create", "update", "remove"]),
  cause: Schema.Defect()
}) {}

export class CommentStore extends Context.Service<CommentStore, {
  list(filter?: CommentFilter): Effect.Effect<Array<Comment>, StoreError>;
  get(id: string): Effect.Effect<Comment | null, StoreError>;
  create(input: CreateCommentInput): Effect.Effect<Comment, StoreError>;
  update(id: string, patch: UpdateCommentInput): Effect.Effect<Comment | null, StoreError>;
  remove(id: string): Effect.Effect<boolean, StoreError>;
}>()("diffreview/server/CommentStore") {
  /**
   * Layer parameterised by the sqlite file path; `":memory:"` keeps the db
   * in-process (used by tests). `Layer.effect` runs the acquisition in the
   * layer's scope, so the `acquireRelease` finalizer closes the database when
   * the layer is torn down — no manual `close()` anywhere.
   */
  static readonly layer = (dbPath: string): Layer.Layer<CommentStore, StoreError> =>
    Layer.effect(
      CommentStore,
      Effect.gen(function*() {
        const db = yield* Effect.acquireRelease(
          Effect.try({
            try: () => openDatabaseSync(dbPath),
            catch: (cause) => new StoreError({ op: "open", cause })
          }),
          (opened) =>
            Effect.sync(() => {
              try {
                opened.close();
              } catch {
                // Already closed.
              }
            })
        );

        return CommentStore.of({
          list: (filter = {}) =>
            Effect.try({
              try: () => listComments(db, filter),
              catch: (cause) => new StoreError({ op: "list", cause })
            }),
          get: (id) =>
            Effect.try({
              try: () => getComment(db, id),
              catch: (cause) => new StoreError({ op: "get", cause })
            }),
          create: (input) =>
            Effect.try({
              try: () => insertComment(db, input),
              catch: (cause) => new StoreError({ op: "create", cause })
            }),
          update: (id, patch) =>
            Effect.try({
              try: () => updateComment(db, id, patch),
              catch: (cause) => new StoreError({ op: "update", cause })
            }),
          remove: (id) =>
            Effect.try({
              try: () => removeComment(db, id),
              catch: (cause) => new StoreError({ op: "remove", cause })
            })
        });
      })
    );
}

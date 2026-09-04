/**
 * Effect Schema definitions for the REST contracts the server owns.
 *
 * These mirror the plain interfaces in `src/shared/types.ts` exactly —
 * parity is enforced by type-level assertions in `api-schemas.test.ts`.
 * Keep this file server-side only: `src/shared/types.ts` must stay
 * dependency-free so the web UI and MCP client can import it.
 */
import { Schema } from "effect";

/**
 * `Schema.Array` yields `ReadonlyArray`, but the shared contracts (and every
 * producer in this codebase, e.g. `DiffWatcher.files`) use mutable arrays.
 * `Schema.mutable` strips the readonly modifier so decoded/encoded types match
 * the shared interfaces exactly (asserted in `api-schemas.test.ts`).
 */
const ArrayOf = <S extends Schema.Top>(schema: S) => Schema.mutable(Schema.Array(schema));

// ---------------------------------------------------------------------------
// Primitives / enums
// ---------------------------------------------------------------------------

export const SideSchema = Schema.Literals(["old", "new"]);
export const StatusSchema = Schema.Literals(["open", "addressed"]);
export const AuthorSchema = Schema.Literals(["user", "agent"]);

/** Positive (1-based) line number — matches zod `z.number().int().positive()`. */
const PositiveIntSchema = Schema.Finite.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThan(0))
);

// ---------------------------------------------------------------------------
// Diff model (GET /api/diff payloads)
// ---------------------------------------------------------------------------

export const DiffLineSchema = Schema.Struct({
  type: Schema.Literals(["add", "del", "context"]),
  oldLine: Schema.optionalKey(Schema.Number),
  newLine: Schema.optionalKey(Schema.Number),
  content: Schema.String
});

export const DiffHunkSchema = Schema.Struct({
  header: Schema.String,
  oldStart: Schema.Number,
  newStart: Schema.Number,
  lines: ArrayOf(DiffLineSchema)
});

export const DiffFileSchema = Schema.Struct({
  oldPath: Schema.NullOr(Schema.String),
  newPath: Schema.NullOr(Schema.String),
  status: Schema.Literals(["added", "modified", "deleted", "renamed"]),
  isBinary: Schema.Boolean,
  hunks: ArrayOf(DiffHunkSchema),
  additions: Schema.Number,
  deletions: Schema.Number
});

// ---------------------------------------------------------------------------
// Comment model
// ---------------------------------------------------------------------------

export const CommentSchema = Schema.Struct({
  id: Schema.String,
  file: Schema.String,
  side: SideSchema,
  line: Schema.Number,
  lineText: Schema.String,
  body: Schema.String,
  author: AuthorSchema,
  status: StatusSchema,
  note: Schema.optionalKey(Schema.String),
  outdated: Schema.optionalKey(Schema.Boolean),
  createdAt: Schema.Number,
  updatedAt: Schema.Number
});

// ---------------------------------------------------------------------------
// Request payloads
// ---------------------------------------------------------------------------

export const CreateCommentRequestSchema = Schema.Struct({
  file: Schema.NonEmptyString,
  side: SideSchema,
  line: PositiveIntSchema,
  lineText: Schema.String,
  body: Schema.NonEmptyString
});

export const UpdateCommentRequestSchema = Schema.Struct({
  status: Schema.optionalKey(StatusSchema),
  note: Schema.optionalKey(Schema.String),
  body: Schema.optionalKey(Schema.NonEmptyString)
}).pipe(
  Schema.check(
    Schema.makeFilter((v) => Object.values(v).some((x) => x !== undefined), {
      message: "empty patch"
    })
  )
);

// ---------------------------------------------------------------------------
// REST responses
// ---------------------------------------------------------------------------

export const MetaSchema = Schema.Struct({
  repoRoot: Schema.String,
  branch: Schema.String,
  head: Schema.String,
  files: Schema.Number,
  additions: Schema.Number,
  deletions: Schema.Number
});

export const GetDiffResponseSchema = Schema.Struct({
  files: ArrayOf(DiffFileSchema)
});

export const ListCommentsResponseSchema = Schema.Struct({
  comments: ArrayOf(CommentSchema)
});

export const ApiErrorResponseSchema = Schema.Struct({
  error: Schema.String
});

// ---------------------------------------------------------------------------
// Server-sent events
// ---------------------------------------------------------------------------

export const SseEventSchema = Schema.Struct({
  type: Schema.Literals(["diff", "comments"]),
  at: Schema.Number
});

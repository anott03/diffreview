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

/** Positive (1-based) line number. */
const PositiveIntSchema = Schema.Finite.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThan(0))
);

/** A runaway client must not bloat the comment store or every list response. */
const bounded = (minimum: number, maximum: number) => Schema.String.pipe(
  Schema.check(Schema.makeFilter(
    (value: string) => value.length >= minimum && value.length <= maximum,
    { message: `expected ${minimum}-${maximum} characters` }
  ))
);

export const CommentTextSchema = bounded(1, 100_000);
export const LineTextSchema = bounded(0, 100_000);

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

export const CommentContextSchema = Schema.Struct({
  source: Schema.Literals(["snapshot", "head"]),
  line: Schema.Number,
  lines: ArrayOf(Schema.Struct({ line: Schema.Number, content: Schema.String }))
});

export const CommentSchema = Schema.Struct({
  id: Schema.String,
  reviewId: Schema.optionalKey(Schema.String),
  reviewHead: Schema.optionalKey(Schema.String),
  historical: Schema.optionalKey(Schema.Boolean),
  file: Schema.String,
  side: SideSchema,
  line: Schema.Number,
  lineText: Schema.String,
  context: Schema.optionalKey(CommentContextSchema),
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
  reviewId: Schema.optionalKey(Schema.NonEmptyString),
  file: Schema.NonEmptyString,
  side: SideSchema,
  line: PositiveIntSchema,
  lineText: LineTextSchema,
  body: CommentTextSchema
});

export const UpdateCommentRequestSchema = Schema.Struct({
  status: Schema.optionalKey(StatusSchema),
  note: Schema.optionalKey(bounded(0, 100_000)),
  body: Schema.optionalKey(CommentTextSchema),
  carryForward: Schema.optionalKey(Schema.Literals([true]))
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

export const ProjectSchema = Schema.Struct({
  id: Schema.String,
  root: Schema.String,
  name: Schema.String,
  openedAt: Schema.Number
});

export const ListProjectsResponseSchema = Schema.Struct({
  projects: ArrayOf(ProjectSchema)
});

export const OpenProjectRequestSchema = Schema.Struct({ path: Schema.NonEmptyString });

export const ServerInfoSchema = Schema.Struct({
  service: Schema.Literal("diffreview"),
  protocolVersion: Schema.Literal(1),
  instanceId: Schema.String,
  pid: Schema.Number,
  startedAt: Schema.Number
});

export const MetaSchema = Schema.Struct({
  repoRoot: Schema.String,
  branch: Schema.String,
  head: Schema.String,
  files: Schema.Number,
  additions: Schema.Number,
  deletions: Schema.Number
});

export const GetDiffResponseSchema = Schema.Struct({
  files: ArrayOf(DiffFileSchema),
  reviewId: Schema.String
});

export const ListFilesResponseSchema = Schema.Struct({
  files: ArrayOf(Schema.String)
});

export const FileContentSchema = Schema.Struct({
  path: Schema.String,
  content: Schema.NullOr(Schema.String),
  baseContent: Schema.optional(Schema.NullOr(Schema.String)),
  reviewId: Schema.optional(Schema.String),
  kind: Schema.Literals(["text", "binary", "too-large", "symlink", "unsupported"])
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

export const SseEventSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["diff", "comments"]),
    projectId: Schema.String,
    at: Schema.Number
  }),
  Schema.Struct({ type: Schema.Literal("projects"), at: Schema.Number })
]);

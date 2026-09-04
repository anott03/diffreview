/**
 * REST API definition (Effect HttpApi) — wire-compatible with the legacy
 * Hono routes in src/server/index.ts: same paths, JSON shapes, and status
 * codes (the web UI and diffreview-mcp parse these).
 *
 * Error payloads are `{ error: string }` bodies (plus a `_tag` discriminator)
 * annotated with their HTTP status via HttpApiSchema.status.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import * as S from "./api-schemas";

/**
 * API errors as TaggedError classes: the `_tag` lets the endpoint's error
 * union encoder pick the right status annotation (plain `{error}` structs
 * would all match the first union member). Wire body:
 * `{"_tag":"...","error":"..."}` — clients read the `error` field.
 */
export class BadRequestError extends Schema.TaggedError<BadRequestError>()("BadRequestError", {
  error: Schema.String
}) {}
export const BadRequestErrorSchema = BadRequestError.pipe(HttpApiSchema.status(400));

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("NotFoundError", {
  error: Schema.String
}) {}
export const NotFoundErrorSchema = NotFoundError.pipe(HttpApiSchema.status(404));

export class InternalError extends Schema.TaggedError<InternalError>()("InternalError", {
  error: Schema.String
}) {}
export const InternalErrorSchema = InternalError.pipe(HttpApiSchema.status(500));

// -- SSE ---------------------------------------------------------------------

/** Wire shape of a diff/comments event payload. */
const SseDataSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literals(["diff", "comments"]), at: Schema.Number }),
  // Heartbeats: `event: ping`, data `{}` — matches the legacy frame format.
  Schema.Struct({})
]);

/**
 * SSE event codec: the handler produces `{ id, event, data }` triples (data
 * JSON-encoded per frame), rendering `event: diff\ndata: {"type":...}` —
 * the exact format the legacy Hono `streamSSE` emitted.
 */
const SseEventCodec = Schema.Struct({
  id: Schema.UndefinedOr(Schema.String),
  event: Schema.String,
  data: Schema.fromJsonString(SseDataSchema)
});

/**
 * `/api` group.
 *
 * The POST/PATCH/DELETE handlers are declared `handleRaw` (interim) so the
 * legacy exact-shape validation in src/server/index.ts stays in force until
 * step 9 (invalid payloads → 400 with a message there, vs. an empty
 * HttpApiSchemaError 400 from a declared payload).
 */
export class ApiGroup extends HttpApiGroup.make("api")
  .add(
    HttpApiEndpoint.get("meta", "/meta", {
      success: S.MetaSchema,
      error: InternalErrorSchema
    })
  )
  .add(
    HttpApiEndpoint.get("diff", "/diff", {
      success: S.GetDiffResponseSchema
    })
  )
  .add(
    HttpApiEndpoint.get("listComments", "/comments", {
      query: {
        status: Schema.optional(Schema.String),
        file: Schema.optional(Schema.String)
      },
      success: S.ListCommentsResponseSchema,
      error: [BadRequestErrorSchema, InternalErrorSchema]
    })
  )
  .add(
    HttpApiEndpoint.post("createComment", "/comments", {
      payload: S.CreateCommentRequestSchema,
      success: S.CommentSchema.pipe(HttpApiSchema.status(201)),
      error: [BadRequestErrorSchema, InternalErrorSchema]
    })
  )
  .add(
    HttpApiEndpoint.patch("updateComment", "/comments/:id", {
      params: { id: Schema.String },
      payload: S.UpdateCommentRequestSchema,
      success: S.CommentSchema,
      error: [NotFoundErrorSchema, BadRequestErrorSchema, InternalErrorSchema]
    })
  )
  .add(
    HttpApiEndpoint.delete("deleteComment", "/comments/:id", {
      params: { id: Schema.String },
      // success defaults to 204 No Content.
      error: [NotFoundErrorSchema, InternalErrorSchema]
    })
  )
  .add(
    HttpApiEndpoint.get("events", "/events", {
      // SSE: the handler merges watcher changes (diff/comments) with 30s
      // pings; the legacy client contract is `event: <type>` + JSON data.
      success: HttpApiSchema.StreamSse({ events: SseEventCodec })
    })
  )
  .prefix("/api") {}

export class Api extends HttpApi.make("diffreview").add(ApiGroup) {}

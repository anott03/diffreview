import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import * as S from "./api-schemas";

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

export class ProjectUnavailableError extends Schema.TaggedError<ProjectUnavailableError>()("ProjectUnavailableError", {
  error: Schema.String
}) {}
export const ProjectUnavailableErrorSchema = ProjectUnavailableError.pipe(HttpApiSchema.status(503));

const projectErrors = [NotFoundErrorSchema, ProjectUnavailableErrorSchema, InternalErrorSchema];
const reviewErrors = [...projectErrors, BadRequestErrorSchema];
const projectParams = { projectId: Schema.String };
const commentParams = { ...projectParams, id: Schema.String };

const SseEventCodec = Schema.Struct({
  id: Schema.UndefinedOr(Schema.String),
  event: Schema.String,
  data: Schema.fromJsonString(Schema.Union([S.SseEventSchema, Schema.Struct({})]))
});

export class ApiGroup extends HttpApiGroup.make("api")
  .add(HttpApiEndpoint.get("server", "/server", { success: S.ServerInfoSchema }))
  .add(HttpApiEndpoint.get("listProjects", "/projects", {
    success: S.ListProjectsResponseSchema,
    error: InternalErrorSchema
  }))
  .add(HttpApiEndpoint.post("openProject", "/projects", {
    payload: S.OpenProjectRequestSchema,
    success: S.ProjectSchema,
    error: reviewErrors
  }))
  .add(HttpApiEndpoint.get("meta", "/projects/:projectId/meta", {
    params: projectParams,
    success: S.MetaSchema,
    error: projectErrors
  }))
  .add(HttpApiEndpoint.get("diff", "/projects/:projectId/diff", {
    params: projectParams,
    success: S.GetDiffResponseSchema,
    error: projectErrors
  }))
  .add(HttpApiEndpoint.get("listFiles", "/projects/:projectId/files", {
    params: projectParams,
    success: S.ListFilesResponseSchema,
    error: projectErrors
  }))
  .add(HttpApiEndpoint.get("file", "/projects/:projectId/file", {
    params: projectParams,
    query: { path: Schema.String },
    success: S.FileContentSchema,
    error: reviewErrors
  }))
  .add(HttpApiEndpoint.get("listComments", "/projects/:projectId/comments", {
    params: projectParams,
    query: { status: Schema.optional(Schema.String), file: Schema.optional(Schema.String) },
    success: S.ListCommentsResponseSchema,
    error: reviewErrors
  }))
  .add(HttpApiEndpoint.post("createComment", "/projects/:projectId/comments", {
    params: projectParams,
    payload: S.CreateCommentRequestSchema,
    success: S.CommentSchema.pipe(HttpApiSchema.status(201)),
    error: reviewErrors
  }))
  .add(HttpApiEndpoint.patch("updateComment", "/projects/:projectId/comments/:id", {
    params: commentParams,
    payload: S.UpdateCommentRequestSchema,
    success: S.CommentSchema,
    error: reviewErrors
  }))
  .add(HttpApiEndpoint.delete("deleteComment", "/projects/:projectId/comments/:id", {
    params: commentParams,
    error: reviewErrors
  }))
  .add(HttpApiEndpoint.get("events", "/events", {
    success: HttpApiSchema.StreamSse({ events: SseEventCodec })
  }))
  .prefix("/api") {}

export class Api extends HttpApi.make("diffreview").add(ApiGroup) {}

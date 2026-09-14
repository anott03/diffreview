import { Cache, Context, Effect, Exit, Layer, flow } from "effect";
import type { Comment, CreateCommentRequest, GetDiffResponse, ListCommentsResponse, Meta, UpdateCommentRequest } from "../shared/types";
import { BadRequestError, InternalError, NotFoundError } from "./api";
import { contextFromDiff, contextFromHead } from "./comment-context";
import { ProjectConfig } from "./config";
import { resolveAnchors } from "./diff";
import { errMessage } from "./error-message";
import { Git } from "./git";
import { CommentStore, type CommentFilter, type CreateCommentInput, type UpdateCommentInput } from "./store";
import { Watcher } from "./watcher";

const toError = flow(errMessage, (error) => Effect.fail(new InternalError({ error })));
type ReviewError = BadRequestError | InternalError | NotFoundError;

export interface CommentQuery {
  status?: string | undefined;
  file?: string | undefined;
}

export class ProjectReview extends Context.Service<ProjectReview, {
  readonly meta: Effect.Effect<Meta, InternalError>;
  readonly diff: Effect.Effect<GetDiffResponse, InternalError>;
  listComments(query: CommentQuery): Effect.Effect<ListCommentsResponse, ReviewError>;
  createComment(input: CreateCommentRequest): Effect.Effect<Comment, ReviewError>;
  updateComment(id: string, input: UpdateCommentRequest): Effect.Effect<Comment, ReviewError>;
  deleteComment(id: string): Effect.Effect<void, ReviewError>;
}>()("diffreview/server/ProjectReview") {
  static readonly layer = Layer.effect(ProjectReview, Effect.gen(function*() {
    const git = yield* Git;
    const watcher = yield* Watcher;
    const store = yield* CommentStore;
    const config = yield* ProjectConfig;
    const committedFiles = yield* Cache.makeWith(
      (revisionPath: string) => git.run(config.repoRoot, ["show", revisionPath]),
      {
        capacity: 128,
        timeToLive: (exit) => Exit.isSuccess(exit) ? "5 minutes" : "5 seconds"
      }
    );

    return ProjectReview.of({
      meta: Effect.gen(function*() {
        const { files } = yield* Effect.catch(watcher.snapshot, toError);
        return yield* Effect.catch(git.getMeta(config.repoRoot, files), toError);
      }),
      diff: watcher.snapshot.pipe(
        Effect.map(({ files, reviewId }) => ({ files, reviewId })),
        Effect.catch(toError)
      ),
      listComments: Effect.fn("ProjectReview.listComments")(function*(query: CommentQuery) {
        const filter: CommentFilter = {};
        if (query.status && query.status !== "all") {
          if (query.status !== "open" && query.status !== "addressed") {
            return yield* Effect.fail(new BadRequestError({ error: `invalid status: ${query.status}` }));
          }
          filter.status = query.status;
        }
        if (query.file) filter.file = query.file;
        const stored = yield* Effect.catch(store.list(filter), toError);
        const { files, reviewId, head } = yield* Effect.catch(watcher.snapshot, toError);
        const resolved = resolveAnchors(files, stored, reviewId);
        for (let i = 0; i < resolved.length; i++) {
          const r = resolved[i]!;
          const o = stored[i]!;
          if (!r.outdated && r.line !== o.line) {
            yield* Effect.catch(store.update(o.id, { line: r.line }), toError);
          }
          if (!r.context) {
            const snapshot = r.historical ? undefined : contextFromDiff(files, r);
            if (snapshot) {
              r.context = snapshot;
              yield* Effect.catch(store.update(o.id, { context: snapshot }), toError);
            } else {
              const text = head ? yield* Cache.get(committedFiles, `${head}:${r.file}`).pipe(
                Effect.catch(() => Effect.succeed(null))
              ) : null;
              const context = text == null ? undefined : contextFromHead(text, r);
              if (context) r.context = context;
            }
          }
        }
        return { comments: resolved };
      }),
      createComment: Effect.fn("ProjectReview.createComment")(function*(input: CreateCommentRequest) {
        yield* Effect.catch(watcher.refresh(), toError);
        const { files, reviewId } = yield* Effect.catch(watcher.snapshot, toError);
        if (input.reviewId !== undefined && input.reviewId !== reviewId) {
          return yield* Effect.fail(new BadRequestError({
            error: "This review ended after HEAD changed. Refresh the diff before adding a comment."
          }));
        }
        const context = contextFromDiff(files, input);
        const creation: CreateCommentInput = { ...input, reviewId, author: "user" };
        if (context) creation.context = context;
        const comment = yield* Effect.catch(store.create(creation), toError);
        yield* watcher.publish({ type: "comments", at: Date.now() });
        return comment;
      }),
      updateComment: Effect.fn("ProjectReview.updateComment")(function*(id: string, input: UpdateCommentRequest) {
        const { carryForward, ...patch } = input;
        const update: UpdateCommentInput = { ...patch };
        if (carryForward) {
          const existing = yield* Effect.catch(store.get(id), toError);
          if (!existing) return yield* Effect.fail(new NotFoundError({ error: "comment not found" }));
          yield* Effect.catch(watcher.refresh(), toError);
          const { files, reviewId } = yield* Effect.catch(watcher.snapshot, toError);
          update.reviewId = reviewId;
          const [resolved] = resolveAnchors(files, [{ ...existing, reviewId }], reviewId);
          if (!resolved!.outdated) {
            update.line = resolved!.line;
            const context = contextFromDiff(files, resolved!);
            if (context) update.context = context;
          }
        }
        const updated = yield* Effect.catch(store.update(id, update), toError);
        if (updated === null) return yield* Effect.fail(new NotFoundError({ error: "comment not found" }));
        yield* watcher.publish({ type: "comments", at: Date.now() });
        return updated;
      }),
      deleteComment: Effect.fn("ProjectReview.deleteComment")(function*(id: string) {
        const removed = yield* Effect.catch(store.remove(id), toError);
        if (!removed) return yield* Effect.fail(new NotFoundError({ error: "comment not found" }));
        yield* watcher.publish({ type: "comments", at: Date.now() });
      })
    });
  }));
}

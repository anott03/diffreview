import { Cache, Context, Effect, Exit, Layer, flow } from "effect";
import type { Comment, CommentSide, CreateCommentRequest, DiffFile, DiffLine, FileContent, GetDiffResponse, ListCommentsResponse, ListFilesResponse, Meta, UpdateCommentRequest } from "../shared/types";
import { diffFilePath } from "../shared/types";
import { BadRequestError, InternalError, NotFoundError } from "./api";
import { contextFromDiff, contextFromHead } from "./comment-context";
import { ProjectConfig } from "./config";
import { buildUntrackedFile, resolveAnchors } from "./diff";
import { errMessage } from "./error-message";
import { Git } from "./git";
import { CommentStore, type CommentFilter, type CreateCommentInput, type UpdateCommentInput } from "./store";
import { Watcher } from "./watcher";
import { normalizeTextLines } from "./text-lines";
import { isWorkingTreePath, listWorkingTreeFiles, readWorkingTreeFile } from "./worktree-files";

const toError = flow(errMessage, (error) => Effect.fail(new InternalError({ error })));
type ReviewError = BadRequestError | InternalError | NotFoundError;
type CommentPath = Pick<Comment, "file" | "side">;
const MAX_ANCHOR_BYTES = 1024 * 1024;

export interface FileOptions {
  context?: boolean | undefined;
  reviewId?: string | undefined;
}

export interface CommentQuery {
  status?: string | undefined;
  file?: string | undefined;
}

export class ProjectReview extends Context.Service<ProjectReview, {
  readonly meta: Effect.Effect<Meta, InternalError>;
  readonly diff: Effect.Effect<GetDiffResponse, InternalError>;
  readonly listFiles: Effect.Effect<ListFilesResponse, InternalError>;
  file(path: string, options?: FileOptions): Effect.Effect<FileContent, ReviewError>;
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
      (revisionPath: string) => Effect.gen(function*() {
        const size = Number(yield* git.run(config.repoRoot, ["cat-file", "-s", revisionPath]));
        if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ANCHOR_BYTES) return null;
        const text = yield* git.run(config.repoRoot, ["cat-file", "blob", revisionPath]);
        if (text.includes("\0") || Buffer.byteLength(text) > MAX_ANCHOR_BYTES) return null;
        if (!text.includes("\r\n")) return text;
        const separator = revisionPath.indexOf(":");
        const entry = yield* git.run(config.repoRoot, [
          "ls-tree", "-z", revisionPath.slice(0, separator), "--", revisionPath.slice(separator + 1)
        ]);
        return entry.startsWith("120000 ") ? text : normalizeTextLines(text);
      }),
      {
        capacity: 128,
        timeToLive: (exit) => Exit.isSuccess(exit) ? "5 minutes" : "5 seconds"
      }
    );

    const listFiles = Effect.gen(function*() {
      const output = yield* Effect.catch(git.run(config.repoRoot, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]), toError);
      return { files: listWorkingTreeFiles(config.repoRoot, output) };
    });

    const anchorFiles = Effect.fn("ProjectReview.anchorFiles")(function*(
      files: DiffFile[], head: string, anchors: CommentPath[]
    ) {
      const requested = new Map<string, Set<CommentSide>>();
      for (const anchor of anchors) {
        const sides = requested.get(anchor.file) ?? new Set<CommentSide>();
        sides.add(anchor.side);
        requested.set(anchor.file, sides);
      }
      const listed = anchors.some((anchor) => anchor.side === "new")
        ? yield* listFiles.pipe(
          Effect.map(({ files }) => new Set(files)),
          Effect.catch(() => Effect.succeed(new Set<string>()))
        ) : new Set<string>();
      const complete = new Set<string>();
      const expanded: DiffFile[] = [];
      for (const [path, sides] of requested) {
        const diff = files.find((file) => diffFilePath(file) === path);
        const file = buildUntrackedFile(path, "");
        for (const side of sides) {
          let text: string | null = null;
          if (side === "new" && listed.has(path)) {
            const content = yield* Effect.try(() => readWorkingTreeFile(config.repoRoot, path)).pipe(
              Effect.catch(() => Effect.succeed(null))
            );
            if (content?.kind === "text" || content?.kind === "symlink") text = content.content;
          } else if (side === "old") {
            const oldPath = diff ? diff.oldPath : path;
            if (head && oldPath && isWorkingTreePath(oldPath)) {
              text = yield* Cache.get(committedFiles, `${head}:${oldPath}`).pipe(
                Effect.catch(() => Effect.succeed(null))
              );
            }
          }
          const hunks = text === null ? diff?.hunks ?? [] : buildUntrackedFile(path, text).hunks;
          if (text !== null) complete.add(`${side}:${path}`);
          file.hunks.push(...hunks.map((hunk) => ({
            ...hunk,
            lines: hunk.lines.flatMap((entry): DiffLine[] => {
              const line = text !== null || side === "new" ? entry.newLine : entry.oldLine;
              if (line === undefined) return [];
              return [side === "new"
                ? { type: "add", newLine: line, content: entry.content }
                : { type: "del", oldLine: line, content: entry.content }];
            })
          })));
        }
        expanded.push(file);
      }
      return { files: expanded, complete };
    });

    return ProjectReview.of({
      listFiles,
      file: Effect.fn("ProjectReview.file")(function*(path: string, options?: FileOptions) {
        if (!isWorkingTreePath(path)) {
          return yield* Effect.fail(new BadRequestError({ error: "invalid file path" }));
        }
        if (options?.context) yield* Effect.catch(watcher.refresh(), toError);
        const snapshot = options?.context ? yield* Effect.catch(watcher.snapshot, toError) : null;
        if (snapshot && options?.reviewId !== undefined && options.reviewId !== snapshot.reviewId) {
          return yield* Effect.fail(new BadRequestError({
            error: "This review ended after HEAD changed. Refresh the diff before expanding context."
          }));
        }
        const { files } = yield* listFiles;
        if (!files.includes(path)) return yield* Effect.fail(new NotFoundError({ error: "file not found" }));
        const content = yield* Effect.try({
          try: () => readWorkingTreeFile(config.repoRoot, path),
          catch: () => new NotFoundError({ error: "file not found" })
        });
        if (snapshot) {
          const diff = snapshot.files.find((file) => diffFilePath(file) === path);
          const oldPath = diff ? diff.oldPath : path;
          content.reviewId = snapshot.reviewId;
          content.baseContent = !snapshot.head || oldPath === null ? ""
            : isWorkingTreePath(oldPath) ? yield* Cache.get(committedFiles, `${snapshot.head}:${oldPath}`).pipe(
              Effect.catch(() => Effect.succeed(null))
            ) : null;
        }
        return content;
      }),
      meta: Effect.gen(function*() {
        const { files } = yield* Effect.catch(watcher.snapshot, toError);
        return yield* Effect.catch(git.getMeta(config.repoRoot, files), toError);
      }),
      diff: watcher.snapshot.pipe(
        Effect.map(({ files, reviewId }) => ({ files, reviewId })),
        Effect.catch(toError)
      ),
      listComments: Effect.fn("ProjectReview.listComments")(function*(query: CommentQuery) {
        // Note: this read persists re-anchored line numbers and HEAD-recovered
        // context snapshots when they change; the store write itself stays
        // idempotent between concurrent requests.
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
        const anchors = yield* anchorFiles(files, head, stored.filter((comment) => comment.reviewId === reviewId));
        const resolved = resolveAnchors(anchors.files, stored, reviewId);
        for (let i = 0; i < resolved.length; i++) {
          const r = resolved[i]!;
          const o = stored[i]!;
          if (!r.outdated && r.line !== o.line) {
            yield* Effect.catch(store.update(o.id, { line: r.line }), toError);
          }
          if (!r.context) {
            const snapshot = r.historical ? undefined : contextFromDiff(anchors.files, r);
            if (snapshot) {
              r.context = snapshot;
              yield* Effect.catch(store.update(o.id, { context: snapshot }), toError);
            } else {
              const diff = files.find((file) => diffFilePath(file) === r.file);
              const path = r.side === "old" && diff ? diff.oldPath : r.file;
              const text = head && path && isWorkingTreePath(path) ? yield* Cache.get(committedFiles, `${head}:${path}`).pipe(
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
        const { files, reviewId, head } = yield* Effect.catch(watcher.snapshot, toError);
        if (input.reviewId !== undefined && input.reviewId !== reviewId) {
          return yield* Effect.fail(new BadRequestError({
            error: "This review ended after HEAD changed. Refresh the diff before adding a comment."
          }));
        }
        if (!isWorkingTreePath(input.file)) {
          return yield* Effect.fail(new BadRequestError({ error: "comment path is not within the working tree" }));
        }
        const anchors = yield* anchorFiles(files, head, [input]);
        const context = contextFromDiff(anchors.files, input);
        if (anchors.complete.has(`${input.side}:${input.file}`) && !context) {
          return yield* Effect.fail(new BadRequestError({
            error: "This line changed. Refresh the file before adding a comment."
          }));
        }
        const creation: CreateCommentInput = { ...input, reviewId, author: "user" };
        if (context) {
          creation.context = context;
          creation.line = context.line;
        }
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
          const { files, reviewId, head } = yield* Effect.catch(watcher.snapshot, toError);
          update.reviewId = reviewId;
          const anchors = yield* anchorFiles(files, head, [existing]);
          const [resolved] = resolveAnchors(anchors.files, [{ ...existing, reviewId }], reviewId);
          if (!resolved!.outdated) {
            update.line = resolved!.line;
            const context = contextFromDiff(anchors.files, resolved!);
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

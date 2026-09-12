/**
 * HTTP server composition (the Effect replacement for the legacy Hono app).
 *
 * Wire behavior matches the legacy server:
 * - same REST paths, JSON shapes, and status codes (201/204/400/404/500)
 * - invalid payloads → 400 `{ error: "<message>" }` via manual body decoding
 *   in raw handlers (declared HttpApi payloads would render an empty 400)
 * - SSE on /api/events: `event: <type>` frames + 30s pings, driven by the
 *   Watcher's PubSub stream; comment mutations publish "comments" events
 * - static UI + SPA fallback when built; actionable 404 text when not
 */
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Cache, Effect, Exit, Layer, Schedule, Schema, Stream, flow } from "effect";
import { NodeFileSystem, NodeHttpServer, NodePath } from "@effect/platform-node";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpRouter, HttpServerRequest, HttpServerResponse, HttpStaticServer } from "effect/unstable/http";
import { resolveAnchors } from "./diff";
import { contextFromDiff, contextFromHead } from "./comment-context";
import * as S from "./api-schemas";
import { Api, BadRequestError, InternalError, NotFoundError } from "./api";
import { CommentStore, type CommentFilter, type CreateCommentInput, type UpdateCommentInput } from "./store";
import { Git } from "./git";
import { Watcher } from "./watcher";
import { Session } from "./session";
import { ServerConfig } from "./config";
import { errMessage } from "./error-message";

// ---------------------------------------------------------------------------
// Error mapping — `{ error: message }` bodies, matching the legacy onError
// ---------------------------------------------------------------------------

const toError = flow(errMessage, (error) => Effect.fail(new InternalError({ error })));

/**
 * Manual JSON body decode for raw handlers: parse failures and schema
 * failures both become a 400 `{ error: "<message>" }` (the legacy zod flow
 * rendered the issue list; HttpApi's declared-payload decoding would render
 * an empty 400 instead).
 */
const parseBody = <A, I, R>(schema: Schema.Codec<A, I, R>) =>
  Effect.gen(function*() {
    const toBadRequest = flow(errMessage, (error) => Effect.fail(new BadRequestError({ error })));
    const input = yield* Effect.catch(HttpServerRequest.schemaBodyJson(Schema.Unknown), toBadRequest);
    return yield* Effect.catch(Schema.decodeUnknownEffect(schema)(input), toBadRequest);
  });

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export const ApiHandlers = HttpApiBuilder.group(
  Api,
  "api",
  Effect.fn(function*(handlers) {
  const git = yield* Git;
  const watcher = yield* Watcher;
  const store = yield* CommentStore;
  const config = yield* ServerConfig;
  const committedFiles = yield* Cache.makeWith(
    (revisionPath: string) => git.run(config.repoRoot, ["show", revisionPath]),
    {
      capacity: 128,
      timeToLive: (exit) => Exit.isSuccess(exit) ? "5 minutes" : "5 seconds"
    }
  );

  return handlers
    .handle("meta", () =>
      Effect.gen(function*() {
        const files = yield* watcher.files;
        return yield* Effect.catch(git.getMeta(config.repoRoot, files), toError);
      }))
    .handle("diff", () => watcher.snapshot.pipe(
      Effect.map(({ files, reviewId }) => ({ files, reviewId })),
      Effect.catch(toError)
    ))
    .handle("listComments", ({ query }) =>
      Effect.gen(function*() {
        const filter: CommentFilter = {};
        if (query.status && query.status !== "all") {
          if (query.status !== "open" && query.status !== "addressed") {
            return yield* Effect.fail(
              new BadRequestError({ error: `invalid status: ${query.status}` })
            );
          }
          filter.status = query.status;
        }
        if (query.file) filter.file = query.file;

        const stored = yield* Effect.catch(store.list(filter), toError);
        const { files, reviewId, head } = yield* Effect.catch(watcher.snapshot, toError);
        const resolved = resolveAnchors(files, stored, reviewId);

        // Persist re-anchored line numbers so anchors converge over time.
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
      }))
    .handleRaw("createComment", () =>
      Effect.gen(function*() {
        const input = yield* parseBody(S.CreateCommentRequestSchema);
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
      }))
    .handleRaw("updateComment", ({ params }) =>
      Effect.gen(function*() {
        const { carryForward, ...patch } = yield* parseBody(S.UpdateCommentRequestSchema);
        const update: UpdateCommentInput = { ...patch };
        if (carryForward) {
          const existing = yield* Effect.catch(store.get(params.id), toError);
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
        const updated = yield* Effect.catch(store.update(params.id, update), toError);
        if (updated === null) {
          return yield* Effect.fail(new NotFoundError({ error: "comment not found" }));
        }
        yield* watcher.publish({ type: "comments", at: Date.now() });
        return updated;
      }))
    .handleRaw("deleteComment", ({ params }) =>
      Effect.gen(function*() {
        const removed = yield* Effect.catch(store.remove(params.id), toError);
        if (!removed) {
          return yield* Effect.fail(new NotFoundError({ error: "comment not found" }));
        }
        yield* watcher.publish({ type: "comments", at: Date.now() });
        return undefined; // 204 No Content
      }))
    .handle("events", () => {
      const events = watcher.changes.pipe(
        Stream.map(
          (e) => ({
            id: undefined,
            event: e.type,
            data: { type: e.type, at: e.at }
          })
        )
      );
      // Heartbeat: `event: ping`, data `{}` — matches the legacy 30s ping.
      const pings = Stream.fromSchedule(Schedule.spaced("30 seconds")).pipe(
        Stream.map(() => ({
          id: undefined,
          event: "ping",
          data: {}
        }))
      );
      return Effect.succeed(Stream.merge(events, pings));
    });
  })
);

// ---------------------------------------------------------------------------
// Unmatched /api/* → JSON 404 (matches the legacy app.notFound behavior)
// ---------------------------------------------------------------------------

export const apiNotFoundRoutes = HttpRouter.add(
  "*",
  "/api/*",
  HttpServerResponse.text(JSON.stringify({ error: "not found" }), {
    status: 404,
    contentType: "application/json"
  })
);

// ---------------------------------------------------------------------------
// Static UI + SPA fallback
// ---------------------------------------------------------------------------

const NOT_BUILT =
  "diffreview UI is not built. Run `pnpm build` to serve it from this port, " +
  "or during development open the vite dev server at http://localhost:5173 (`pnpm dev`).";

/**
 * Static assets + SPA fallback when the UI is built; an actionable 404 text
 * otherwise. `webRoot` is computed by the cli via findWebRoot() (guarded:
 * only dist/web builds with index.html + assets/ are served).
 */
export const webRoutes = (webRoot: string | null) =>
  webRoot
    ? HttpStaticServer.layer({ root: webRoot, spa: true, index: "index.html" })
    : HttpRouter.add("GET", "/*", HttpServerResponse.text(NOT_BUILT, { status: 404 }));

// ---------------------------------------------------------------------------
// Server layer
// ---------------------------------------------------------------------------

/**
 * Built UI lives at dist/web relative to the bundled server (dist/server).
 * Only accept a directory that looks like a vite build (index.html + assets/):
 * in dev, `../web` resolves to the *source* src/web, which must NOT be served
 * (browsers can't execute raw .tsx — blank page + MIME type errors).
 */
export function findWebRoot(): string | null {
  const candidate = fileURLToPath(new URL("../web", import.meta.url));
  return existsSync(join(candidate, "index.html")) && existsSync(join(candidate, "assets"))
    ? candidate
    : null;
}

/** The api route layer: endpoint implementations registered into the router. */
export const ApiRoutes = HttpApiBuilder.layer(Api).pipe(Layer.provide(ApiHandlers));

export interface ServerOptions {
  repoRoot: string;
  port: number;
  intervalMs: number;
  open: boolean;
  dbPath: string;
  webRoot: string | null;
}

/**
 * The complete HTTP server: routes (api + static) served over a Node http
 * server bound to 127.0.0.1, with all domain services provided. The domain
 * services are also exposed as the layer's output (provideMerge) so the cli
 * program can drive them (initial refresh, session bookkeeping).
 */
export const serverLayer = (options: ServerOptions) => {
  // Share the same single-writer store between the watcher and HTTP handlers.
  const core = Git.layer.pipe(Layer.merge(CommentStore.layer(options.dbPath)));
  const services = Watcher.layer({ root: options.repoRoot, intervalMs: options.intervalMs }).pipe(
    Layer.provideMerge(core),
    Layer.merge(Session.layer),
    Layer.merge(
      Layer.succeed(ServerConfig, {
        repoRoot: options.repoRoot,
        port: options.port,
        intervalMs: options.intervalMs,
        open: options.open,
        dbPath: options.dbPath,
        webRoot: options.webRoot
      })
    )
  );

  return HttpRouter.serve(
    Layer.mergeAll(ApiRoutes, apiNotFoundRoutes, webRoutes(options.webRoot))
  ).pipe(
    Layer.provide([
      NodeHttpServer.layer(() => createServer(), {
        port: options.port,
        host: "127.0.0.1"
      }),
      NodeFileSystem.layer,
      NodePath.layer,
      services
    ]),
    Layer.provideMerge(services)
  );
};

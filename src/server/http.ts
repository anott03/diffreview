/**
 * HTTP server composition (replaces the legacy Hono app in index.ts once the
 * cli switches over in step 9 of .thoughts/effect-migration.md).
 *
 * Wire behavior mirrors index.ts:
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
import { Effect, Layer, Schedule, Schema, Stream } from "effect";
import { NodeFileSystem, NodeHttpServer, NodePath } from "@effect/platform-node";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpRouter, HttpServerRequest, HttpServerResponse, HttpStaticServer } from "effect/unstable/http";
import type { CommentStatus, SseEventType } from "../shared/types";
import { resolveAnchors } from "./diff";
import * as S from "./api-schemas";
import { Api, BadRequestError, InternalError, NotFoundError } from "./api";
import { CommentStore } from "./store";
import { Git } from "./git";
import { Watcher } from "./watcher";
import { Session } from "./session";
import { ServerConfig } from "./config";

// ---------------------------------------------------------------------------
// Error mapping — `{ error: message }` bodies, matching the legacy onError
// ---------------------------------------------------------------------------

const errMessage = (e: unknown): string => {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === "object" && e !== null) {
    const anyErr = e as { message?: unknown; cause?: unknown };
    if (typeof anyErr.message === "string" && anyErr.message) return anyErr.message;
    if (anyErr.cause instanceof Error && anyErr.cause.message) return anyErr.cause.message;
  }
  return "internal error";
};

const toError = (e: unknown) => Effect.fail(new InternalError({ error: errMessage(e) }));

/**
 * Manual JSON body decode for raw handlers: parse failures and schema
 * failures both become a 400 `{ error: "<message>" }` (the legacy zod flow
 * rendered the issue list; HttpApi's declared-payload decoding would render
 * an empty 400 instead).
 */
const parseBody = <A, I, R>(schema: Schema.Codec<A, I, R>) =>
  Effect.gen(function*() {
    const toBadRequest = (e: unknown) => Effect.fail(new BadRequestError({ error: errMessage(e) }));
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

  return handlers
    .handle("meta", () =>
      Effect.gen(function*() {
        const files = yield* watcher.files;
        return yield* Effect.catch(git.getMeta(config.repoRoot, files), toError);
      }))
    .handle("diff", () => Effect.map(watcher.files, (files) => ({ files })))
    .handle("listComments", ({ query }) =>
      Effect.gen(function*() {
        const filter: { status?: CommentStatus; file?: string } = {};
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
        const resolved = resolveAnchors(yield* watcher.files, stored);

        // Persist re-anchored line numbers so anchors converge over time.
        for (let i = 0; i < resolved.length; i++) {
          const r = resolved[i]!;
          const o = stored[i]!;
          if (!r.outdated && r.line !== o.line) {
            yield* Effect.catch(store.update(o.id, { line: r.line }), toError);
          }
        }

        return { comments: resolved };
      }))
    .handleRaw("createComment", () =>
      Effect.gen(function*() {
        const input = yield* parseBody(S.CreateCommentRequestSchema);
        const comment = yield* Effect.catch(store.create({ ...input, author: "user" }), toError);
        yield* watcher.publish({ type: "comments", at: Date.now() });
        return comment;
      }))
    .handleRaw("updateComment", ({ params }) =>
      Effect.gen(function*() {
        const patch = yield* parseBody(S.UpdateCommentRequestSchema);
        const updated = yield* Effect.catch(store.update(params.id, patch), toError);
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
          (e): { id: string | undefined; event: SseEventType; data: { type: SseEventType; at: number } } => ({
            id: undefined,
            event: e.type,
            data: { type: e.type, at: e.at }
          })
        )
      );
      // Heartbeat: `event: ping`, data `{}` — matches the legacy 30s ping.
      const pings = Stream.fromSchedule(Schedule.spaced("30 seconds")).pipe(
        Stream.map((): { id: string | undefined; event: string; data: {} } => ({
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
  // Note: Layer.merge (not mergeAll — that one's for no-output layers and
  // collapses service outputs). Watcher gets Git provided privately, so the
  // merged layer's requirements stay empty.
  const services = Git.layer.pipe(
    Layer.merge(CommentStore.layer(options.dbPath)),
    Layer.merge(
      Watcher.layer({ root: options.repoRoot, intervalMs: options.intervalMs }).pipe(
        Layer.provide(Git.layer)
      )
    ),
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

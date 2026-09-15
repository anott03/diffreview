import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Schedule, Schema, Stream, flow } from "effect";
import { NodeFileSystem, NodeHttpServer, NodePath } from "@effect/platform-node";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpRouter, HttpServerRequest, HttpServerResponse, HttpStaticServer } from "effect/unstable/http";
import * as S from "./api-schemas";
import { Api, BadRequestError } from "./api";
import { Git } from "./git";
import { ServerConfig, type ServerOptions } from "./config";
import { errMessage } from "./error-message";
import { ProjectCatalog } from "./project-catalog";
import { ProjectRegistry } from "./project-registry";

export type { ServerOptions } from "./config";

const parseBody = <A, I, R>(schema: Schema.Codec<A, I, R>) => Effect.gen(function*() {
  const toBadRequest = flow(errMessage, (error) => Effect.fail(new BadRequestError({ error })));
  const input = yield* Effect.catch(HttpServerRequest.schemaBodyJson(Schema.Unknown), toBadRequest);
  return yield* Effect.catch(Schema.decodeUnknownEffect(schema)(input), toBadRequest);
});

export const ApiHandlers = HttpApiBuilder.group(Api, "api", Effect.fn(function*(handlers) {
  const registry = yield* ProjectRegistry;
  const config = yield* ServerConfig;
  return handlers
    .handle("server", () => Effect.succeed({
      service: "diffreview" as const,
      protocolVersion: 1 as const,
      instanceId: config.instanceId,
      pid: process.pid,
      startedAt: config.startedAt
    }))
    .handle("listProjects", () => Effect.map(registry.projects, (projects) => ({ projects })))
    .handleRaw("openProject", () => Effect.gen(function*() {
      const { path } = yield* parseBody(S.OpenProjectRequestSchema);
      return yield* registry.open(path);
    }))
    .handle("meta", ({ params }) => Effect.flatMap(registry.get(params.projectId), ({ review }) => review.meta))
    .handle("diff", ({ params }) => Effect.flatMap(registry.get(params.projectId), ({ review }) => review.diff))
    .handle("listFiles", ({ params }) => Effect.flatMap(registry.get(params.projectId), ({ review }) => review.listFiles))
    .handle("file", ({ params, query }) => Effect.flatMap(registry.get(params.projectId), ({ review }) => review.file(query.path, {
      context: query.context === "true", reviewId: query.reviewId
    })))
    .handle("listComments", ({ params, query }) =>
      Effect.flatMap(registry.get(params.projectId), ({ review }) => review.listComments(query)))
    .handleRaw("createComment", ({ params }) => Effect.gen(function*() {
      const input = yield* parseBody(S.CreateCommentRequestSchema);
      const { review } = yield* registry.get(params.projectId);
      return yield* review.createComment(input);
    }))
    .handleRaw("updateComment", ({ params }) => Effect.gen(function*() {
      const input = yield* parseBody(S.UpdateCommentRequestSchema);
      const { review } = yield* registry.get(params.projectId);
      return yield* review.updateComment(params.id, input);
    }))
    .handleRaw("deleteComment", ({ params }) => Effect.gen(function*() {
      const { review } = yield* registry.get(params.projectId);
      return yield* review.deleteComment(params.id);
    }))
    .handle("events", () => {
      const events = registry.changes.pipe(Stream.map((event) => ({
        id: undefined,
        event: event.type,
        data: event
      })));
      const pings = Stream.fromSchedule(Schedule.spaced("30 seconds")).pipe(Stream.map(() => ({
        id: undefined,
        event: "ping",
        data: {}
      })));
      return Effect.succeed(Stream.merge(events, pings));
    });
}));

export const apiNotFoundRoutes = HttpRouter.add(
  "*",
  "/api/*",
  HttpServerResponse.text(JSON.stringify({ error: "not found" }), {
    status: 404,
    contentType: "application/json"
  })
);

/**
 * Reject DNS-rebinding requests: a malicious page can rebind attacker.com to
 * 127.0.0.1 and reach any loopback-bound server. Only loopback host headers
 * that a real browser would produce for this server are accepted.
 */
export const loopbackHosts = (port: number) => HttpRouter.middleware((httpEffect) =>
  Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
    const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, "127.0.0.1", "localhost"]);
    return allowed.has(request.headers["host"] ?? "")
      ? httpEffect
      : Effect.succeed(HttpServerResponse.text("Forbidden", {
        status: 403,
        contentType: "text/plain"
      }));
  }), { global: true });

const NOT_BUILT =
  "diffreview UI is not built. Run `pnpm build` to serve it from this port, " +
  "or during development open the vite dev server at http://localhost:5173 (`pnpm dev`).";

export const webRoutes = (webRoot: string | null) => webRoot
  ? HttpStaticServer.layer({ root: webRoot, spa: true, index: "index.html" })
  : HttpRouter.add("GET", "/*", HttpServerResponse.text(NOT_BUILT, { status: 404 }));

export function findWebRoot(): string | null {
  const candidate = fileURLToPath(new URL("../web", import.meta.url));
  return existsSync(join(candidate, "index.html")) && existsSync(join(candidate, "assets")) ? candidate : null;
}

export const ApiRoutes = HttpApiBuilder.layer(Api).pipe(Layer.provide(ApiHandlers));

export const projectServices = (options: ServerOptions, catalogPath?: string) => {
  const core = Git.layer.pipe(
    Layer.merge(ProjectCatalog.layer(catalogPath)),
    Layer.merge(Layer.succeed(ServerConfig, options))
  );
  return ProjectRegistry.layer.pipe(Layer.provideMerge(core));
};

export const serverLayer = (options: ServerOptions) => {
  const services = projectServices(options);
  const routes = Layer.mergeAll(ApiRoutes, apiNotFoundRoutes, webRoutes(options.webRoot)).pipe(
    Layer.provide(loopbackHosts(options.port))
  );
  return HttpRouter.serve(routes).pipe(
    Layer.provide([
      NodeHttpServer.layer(() => createServer(), { port: options.port, host: "127.0.0.1" }),
      NodeFileSystem.layer,
      NodePath.layer,
      services
    ]),
    Layer.provideMerge(services)
  );
};

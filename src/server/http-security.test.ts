import { Effect, Layer, Stream } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRoutes } from "./http";
import { NotFoundError } from "./api";
import { ServerConfig } from "./config";
import { ProjectRegistry } from "./project-registry";

const invoked = vi.fn();
const project = { id: "test", root: "/test", name: "test", openedAt: 123 };
const registry = Layer.succeed(ProjectRegistry, ProjectRegistry.of({
  projects: Effect.succeed([project]),
  changes: Stream.empty,
  open: () => Effect.sync(() => {
    invoked();
    return project;
  }),
  get: () => Effect.sync(() => invoked()).pipe(
    Effect.andThen(Effect.fail(new NotFoundError({ error: "comment not found" })))
  )
}));
const probe = Effect.sync(() => {
  invoked();
  return HttpServerResponse.empty({ status: 204 });
});
const probeRoutes = Layer.mergeAll(
  HttpRouter.add("GET", "/api/security", probe),
  HttpRouter.add("OPTIONS", "/api/security", probe),
  HttpRouter.add("PUT", "/api/security", probe)
);
const app = HttpRouter.toWebHandler(Layer.merge(ApiRoutes, probeRoutes).pipe(Layer.provide([
  HttpServer.layerServices,
  registry,
  Layer.succeed(ServerConfig, { port: 4777, intervalMs: 25, webRoot: null, instanceId: "security-test", startedAt: 123 })
])));

const mutations = [
  { method: "POST", path: "/api/projects", body: JSON.stringify({ path: "/test" }), status: 200 },
  { method: "PATCH", path: "/api/projects/test/comments/test", body: JSON.stringify({ status: "addressed" }), status: 404 },
  { method: "PUT", path: "/api/security", body: "{}", status: 204 },
  { method: "DELETE", path: "/api/projects/test/comments/test", body: undefined, status: 404 }
] as const;
const request = (path: string, init: RequestInit) => app.handler(new Request(`http://localhost:4777${path}`, init));

beforeEach(() => invoked.mockClear());
afterAll(() => app.dispose());

describe("API mutation protection", () => {
  describe.each(mutations)("$method", ({ method, path, body, status }) => {
    it.each([
      { name: "same-origin browser", headers: new Headers({ origin: "http://localhost:4777", "sec-fetch-site": "same-origin" }) },
      { name: "CLI without Origin", headers: new Headers() },
      { name: "CLI with Fetch Metadata none", headers: new Headers({ "sec-fetch-site": "none" }) }
    ])("allows $name", async ({ headers }) => {
      const response = await request(path, {
        method, body,
        headers: new Headers([["host", "localhost:4777"], ["content-type", "application/json"], ...headers])
      });
      expect(response.status).toBe(status);
      expect(invoked).toHaveBeenCalledOnce();
    });

    it.each([
      { name: "foreign Origin", headers: new Headers({ origin: "https://attacker.example" }) },
      { name: "null Origin", headers: new Headers({ origin: "null" }) },
      { name: "same-site different port", headers: new Headers({ origin: "http://localhost:5173" }) },
      { name: "same-site Fetch Metadata", headers: new Headers({ "sec-fetch-site": "same-site" }) },
      { name: "cross-site Fetch Metadata without Origin", headers: new Headers({ "sec-fetch-site": "cross-site" }) },
      { name: "cross-site Fetch Metadata with matching Origin", headers: new Headers({ origin: "http://localhost:4777", "sec-fetch-site": "cross-site" }) }
    ])("rejects $name before decoding or invoking handlers", async ({ headers }) => {
      const response = await request(path, {
        method, body: method === "DELETE" ? undefined : "{ invalid JSON",
        headers: new Headers([["host", "localhost:4777"], ["content-type", "application/json"], ...headers])
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Cross-origin mutation requests are not allowed." });
      expect(invoked).not.toHaveBeenCalled();
    });
  });

  describe.each(mutations.filter(({ method }) => method !== "DELETE"))("$method content type", ({ method, path, body, status }) => {
    it.each([undefined, "text/plain", "application/x-www-form-urlencoded", "multipart/form-data", "application/jsonp"])(
      "rejects %s before decoding or invoking handlers", async (contentType) => {
        const headers = new Headers({ host: "localhost:4777", origin: "http://localhost:4777" });
        if (contentType !== undefined) headers.set("content-type", contentType);
        const response = await request(path, {
          method, headers, body: new TextEncoder().encode("{ invalid JSON")
        });
        expect(response.status).toBe(415);
        expect(await response.json()).toEqual({ error: "Mutation requests require Content-Type: application/json." });
        expect(invoked).not.toHaveBeenCalled();
      }
    );

    it.each(["application/json; charset=utf-8", "Application/JSON ; charset=UTF-8"])("accepts %s", async (contentType) => {
      const response = await request(path, {
        method, body,
        headers: { host: "localhost:4777", origin: "http://localhost:4777", "content-type": contentType }
      });
      expect(response.status).toBe(status);
      expect(invoked).toHaveBeenCalledOnce();
    });
  });

  it("allows same-origin DELETE without a content type", async () => {
    const response = await request("/api/projects/test/comments/test", {
      method: "DELETE", headers: { host: "localhost:4777", origin: "http://localhost:4777" }
    });
    expect(response.status).toBe(404);
    expect(invoked).toHaveBeenCalledOnce();
  });

  it.each(["GET", "HEAD", "OPTIONS"])("leaves safe %s requests unaffected", async (method) => {
    const response = await request("/api/security", {
      method,
      headers: { host: "localhost:4777", origin: "null", "sec-fetch-site": "cross-site", "content-type": "text/plain" }
    });
    expect(response.status).toBe(204);
    expect(invoked).toHaveBeenCalledOnce();
  });
});

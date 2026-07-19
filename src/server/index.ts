import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type {
  ApiErrorResponse,
  CommentStatus,
  GetDiffResponse,
  ListCommentsResponse,
  SseEventType,
} from "../shared/types";
import { resolveAnchors } from "./diff";
import { getMeta, type DiffWatcher } from "./git";
import type { CommentStore } from "./store";

export interface AppDeps {
  repoRoot: string;
  store: CommentStore;
  watcher: DiffWatcher;
}

const createCommentSchema = z.object({
  file: z.string().min(1),
  side: z.enum(["old", "new"]),
  line: z.number().int().positive(),
  lineText: z.string(),
  body: z.string().min(1),
});

const updateCommentSchema = z
  .object({
    status: z.enum(["open", "addressed"]).optional(),
    note: z.string().optional(),
    body: z.string().min(1).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "empty patch" });

function zodError(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

/** Built UI lives at dist/web relative to the bundled server (dist/server). */
function findWebRoot(): string | null {
  const candidate = fileURLToPath(new URL("../web", import.meta.url));
  return existsSync(candidate) ? candidate : null;
}

export function createApp(deps: AppDeps) {
  const app = new Hono();
  const sseClients = new Set<(event: SseEventType, at: number) => void>();

  const broadcast = (event: SseEventType) => {
    const at = Date.now();
    for (const client of sseClients) client(event, at);
  };

  // Diff changes flow from the poll loop to all SSE clients.
  deps.watcher.onChange = () => broadcast("diff");

  app.onError((err, c) => {
    console.error("[diffreview] request error:", err);
    const body: ApiErrorResponse = { error: err.message || "internal error" };
    return c.json(body, 500);
  });

  // -- API ------------------------------------------------------------------

  app.get("/api/meta", async (c) => {
    return c.json(await getMeta(deps.repoRoot, deps.watcher.files));
  });

  app.get("/api/diff", (c) => {
    const body: GetDiffResponse = { files: deps.watcher.files };
    return c.json(body);
  });

  app.get("/api/comments", (c) => {
    const status = c.req.query("status");
    const file = c.req.query("file");

    const filter: { status?: CommentStatus; file?: string } = {};
    if (status && status !== "all") {
      if (status !== "open" && status !== "addressed") {
        return c.json({ error: `invalid status: ${status}` } satisfies ApiErrorResponse, 400);
      }
      filter.status = status;
    }
    if (file) filter.file = file;

    const stored = deps.store.list(filter);
    const resolved = resolveAnchors(deps.watcher.files, stored);

    // Persist re-anchored line numbers so anchors converge over time.
    for (let i = 0; i < resolved.length; i++) {
      const r = resolved[i]!;
      const o = stored[i]!;
      if (!r.outdated && r.line !== o.line) {
        deps.store.update(o.id, { line: r.line });
      }
    }

    const body: ListCommentsResponse = { comments: resolved };
    return c.json(body);
  });

  app.post("/api/comments", async (c) => {
    const parsed = createCommentSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: zodError(parsed.error) } satisfies ApiErrorResponse, 400);
    }
    const comment = deps.store.create({ ...parsed.data, author: "user" });
    broadcast("comments");
    return c.json(comment, 201);
  });

  app.patch("/api/comments/:id", async (c) => {
    const parsed = updateCommentSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: zodError(parsed.error) } satisfies ApiErrorResponse, 400);
    }
    const updated = deps.store.update(c.req.param("id"), parsed.data);
    if (!updated) {
      return c.json({ error: "comment not found" } satisfies ApiErrorResponse, 404);
    }
    broadcast("comments");
    return c.json(updated);
  });

  app.delete("/api/comments/:id", (c) => {
    if (!deps.store.remove(c.req.param("id"))) {
      return c.json({ error: "comment not found" } satisfies ApiErrorResponse, 404);
    }
    broadcast("comments");
    return c.body(null, 204);
  });

  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const client = (event: SseEventType, at: number) => {
        void stream.writeSSE({ event, data: JSON.stringify({ type: event, at }) }).catch(() => {});
      };
      sseClients.add(client);
      const ping = setInterval(() => {
        void stream.writeSSE({ event: "ping", data: "{}" }).catch(() => {});
      }, 30_000);
      stream.onAbort(() => {
        clearInterval(ping);
        sseClients.delete(client);
      });
      await new Promise(() => {}); // keep the stream open
    }),
  );

  // -- Static UI (production build) ------------------------------------------

  const webRoot = findWebRoot();
  let indexHtml: string | null = null;
  if (webRoot) {
    try {
      indexHtml = readFileSync(join(webRoot, "index.html"), "utf8");
    } catch {
      indexHtml = null;
    }
    app.use("/*", serveStatic({ root: webRoot }));
  }

  app.notFound((c) => {
    if (c.req.path.startsWith("/api/")) {
      return c.json({ error: "not found" } satisfies ApiErrorResponse, 404);
    }
    if (indexHtml) return c.html(indexHtml); // SPA fallback
    return c.text("diffreview UI is not built. Run `pnpm build`, or use `pnpm dev:web` during development.");
  });

  return app;
}

export function startServer(app: Hono, port: number): Promise<ReturnType<typeof serve>> {
  const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => resolve(server));
  });
}

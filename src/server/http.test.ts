/**
 * Integration tests for the Effect HTTP server (http.ts + api.ts).
 *
 * These assert the exact wire contract the web UI and diffreview-mcp depend
 * on: paths, JSON shapes, and status codes (201/204/400/404), served through
 * HttpRouter.toWebHandler (no port binding; real git repo + in-memory store).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { ApiRoutes, apiNotFoundRoutes, webRoutes } from "./http";
import { CommentStore } from "./store";
import { Git } from "./git";
import { Watcher } from "./watcher";
import { ServerConfig } from "./config";

const execFileAsync = promisify(execFile);
const git = (cwd: string, args: string[]) => execFileAsync("git", args, { cwd });

let repoDir: string;
let handler: (req: Request) => Promise<Response>;
let dispose: () => Promise<void>;

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "diffreview-http-"));
  await git(dir, ["init", "--quiet"]);
  await git(dir, ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "--quiet", "--allow-empty", "-m", "init"]);
  await writeFile(join(dir, "a.txt"), "one\ntwo\nthree\n");
  await git(dir, ["add", "."]);
  await git(dir, ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "--quiet", "-m", "a"]);
  // Uncommitted change so the diff is non-empty.
  await writeFile(join(dir, "a.txt"), "one\nTWO\nthree\n");
  return dir;
}

beforeAll(async () => {
  repoDir = await makeRepo();
  const routes = Layer.mergeAll(ApiRoutes, apiNotFoundRoutes, webRoutes(null));
  const app = routes.pipe(
    Layer.provide([
      HttpServer.layerServices,
      Git.layer,
      CommentStore.layer(":memory:"),
      Watcher.layer({ root: repoDir, intervalMs: 25 }).pipe(Layer.provide(Git.layer)),
      Layer.succeed(ServerConfig, {
        repoRoot: repoDir,
        port: 0,
        intervalMs: 25,
        open: false,
        dbPath: ":memory:",
        webRoot: null
      })
    ])
  );
  const web = HttpRouter.toWebHandler(app);
  handler = web.handler;
  dispose = web.dispose;
});

afterAll(async () => {
  await dispose?.();
  await rm(repoDir, { recursive: true, force: true });
});

const json = async (res: Response): Promise<any> => {
  const text = await res.text();
  return text ? JSON.parse(text) : undefined;
};

/** Wait (up to `ms`) until `predicate` holds; returns the last value. */
async function waitFor<T>(getValue: () => Promise<T>, predicate: (v: T) => boolean, ms = 3000): Promise<T> {
  const deadline = Date.now() + ms;
  let value = await getValue();
  while (!predicate(value) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    value = await getValue();
  }
  return value;
}

describe("Effect HTTP server (wire contract)", () => {
  it("GET /api/meta — shape matches shared Meta", async () => {
    const meta = await waitFor(
      async () => (await handler(new Request("http://localhost/api/meta"))).json(),
      (m: any) => m.files === 1
    );
    expect(meta).toEqual({
      repoRoot: repoDir,
      branch: expect.any(String),
      head: expect.any(String),
      files: 1,
      additions: 1,
      deletions: 1
    });
  });

  it("GET /api/diff — { files: [...] }", async () => {
    const body = await (await handler(new Request("http://localhost/api/diff"))).json();
    expect(body.files).toHaveLength(1);
    expect(body.files[0].newPath).toBe("a.txt");
    expect(body.files[0].status).toBe("modified");
  });

  it("comment CRUD — 201/200/204 + shapes", async () => {
    // create → 201, author user, status open
    const created = await handler(new Request("http://localhost/api/comments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: "a.txt", side: "old", line: 2, lineText: "two", body: "note this" })
    }));
    expect(created.status).toBe(201);
    const comment = await created.json();
    expect(comment).toMatchObject({
      file: "a.txt",
      side: "old",
      line: 2,
      lineText: "two",
      body: "note this",
      author: "user",
      status: "open"
    });
    expect(typeof comment.id).toBe("string");
    expect(typeof comment.createdAt).toBe("number");

    // list → { comments: [...] }
    const list = await (await handler(new Request("http://localhost/api/comments"))).json();
    expect(list.comments).toHaveLength(1);
    expect(list.comments[0].id).toBe(comment.id);

    // list with filters → ok
    const open = await (await handler(new Request("http://localhost/api/comments?status=open"))).json();
    expect(open.comments).toHaveLength(1);

    // patch → 200 + updated fields
    const patched = await handler(new Request(`http://localhost/api/comments/${comment.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "addressed", note: "done" })
    }));
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ status: "addressed", note: "done" });

    // delete → 204, then 404
    const deleted = await handler(new Request(`http://localhost/api/comments/${comment.id}`, { method: "DELETE" }));
    expect(deleted.status).toBe(204);
    const gone = await handler(new Request(`http://localhost/api/comments/${comment.id}`, { method: "DELETE" }));
    expect(gone.status).toBe(404);
  });

  it("PATCH missing id → 404 { error: 'comment not found' }", async () => {
    const res = await handler(new Request("http://localhost/api/comments/nope", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "addressed" })
    }));
    expect(res.status).toBe(404);
    expect(await json(res)).toMatchObject({ error: "comment not found" });
  });

  it("invalid payloads → 400 with { error: message }", async () => {
    // Malformed JSON body
    const bad1 = await handler(new Request("http://localhost/api/comments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json"
    }));
    expect(bad1.status).toBe(400);
    expect(typeof (await json(bad1)).error).toBe("string");

    // Schema-invalid body (empty file, missing fields)
    const bad2 = await handler(new Request("http://localhost/api/comments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: "", body: "" })
    }));
    expect(bad2.status).toBe(400);
    expect(typeof (await json(bad2)).error).toBe("string");

    // Empty patch object (the "empty patch" refinement)
    const bad3 = await handler(new Request("http://localhost/api/comments/x", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    }));
    expect(bad3.status).toBe(400);
    expect(typeof (await json(bad3)).error).toBe("string");
  });

  it("invalid status query → 400 { error: 'invalid status: bogus' }", async () => {
    const res = await handler(new Request("http://localhost/api/comments?status=bogus"));
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: "invalid status: bogus" });
  });

  it("unknown /api path → 404 { error: 'not found' }", async () => {
    const res = await handler(new Request("http://localhost/api/definitely-not-a-route"));
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: "not found" });
  });

  it("unbuilt UI → 404 text with a hint", async () => {
    const res = await handler(new Request("http://localhost/"));
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("diffreview UI is not built");
  });

  it("SSE: diff event frames arrive over /api/events", async () => {
    const res = await handler(new Request("http://localhost/api/events"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + 4000;
    while (!text.includes("event:") && Date.now() < deadline) {
      // Trigger a real diff change; the watcher polls every 25ms.
      await appendFile(join(repoDir, "a.txt"), "x\n");
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value);
    }
    await reader.cancel();

    expect(text).toContain("event: diff");
    expect(text).toContain('"type":"diff"');
    expect(text).toMatch(/"at":\d+/);
  });
});

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
import { Layer, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { ApiRoutes, apiNotFoundRoutes, projectServices, webRoutes } from "./http";
import type { CommentSide, UpdateCommentRequest } from "../shared/types";
import * as S from "./api-schemas";

const execFileAsync = promisify(execFile);
const git = (cwd: string, args: string[]) => execFileAsync("git", args, { cwd });

let repoDir: string;
let storageDir: string;
let projectUrl: string;
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
  storageDir = await mkdtemp(join(tmpdir(), "diffreview-http-data-"));
  const app = routes.pipe(Layer.provide([
    HttpServer.layerServices,
    projectServices({ port: 0, intervalMs: 25, webRoot: null, instanceId: "http-test", startedAt: Date.now() }, join(storageDir, "projects.sqlite"))
  ]));
  const web = HttpRouter.toWebHandler(app);
  handler = web.handler;
  dispose = web.dispose;
  const opened = await handler(new Request("http://localhost/api/projects", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: repoDir })
  }));
  const project = Schema.decodeUnknownSync(S.ProjectSchema)(await opened.json());
  projectUrl = `http://localhost/api/projects/${project.id}`;
});

afterAll(async () => {
  await dispose?.();
  await rm(repoDir, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});

const json = async <A, I>(res: Response, schema: Schema.Codec<A, I>): Promise<A> =>
  Schema.decodeUnknownSync(schema)(await res.json());

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
      async () => json(await handler(new Request(`${projectUrl}/meta`)), S.MetaSchema),
      (m) => m.files === 1
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
    const body = await json(await handler(new Request(`${projectUrl}/diff`)), S.GetDiffResponseSchema);
    expect(body.files).toHaveLength(1);
    expect(body.files[0]!.newPath).toBe("a.txt");
    expect(body.files[0]!.status).toBe("modified");
  });

  it("GET /api/commits — lists current branch history and shows a commit's diff", async () => {
    const list = await json(await handler(new Request(`${projectUrl}/commits`)), S.ListCommitsResponseSchema);
    expect(list.commits.length).toBeGreaterThanOrEqual(2);
    const newest = list.commits[0]!;
    expect(newest.id).toMatch(/^[0-9a-f]{40}$/);
    expect(newest.subject).toBe("a");

    const diff = await json(
      await handler(new Request(`${projectUrl}/commits/${newest.id}/diff`)),
      S.GetCommitDiffResponseSchema
    );
    expect(diff.files).toHaveLength(1);
    expect(diff.files[0]!.newPath).toBe("a.txt");
    expect(diff.files[0]!.status).toBe("added");
    expect(diff.files[0]!.additions).toBe(3);

    const missing = await handler(new Request(`${projectUrl}/commits/${"0".repeat(40)}/diff`));
    expect(missing.status).toBe(404);
    expect(await json(missing, S.ApiErrorResponseSchema)).toMatchObject({ error: "commit not found" });

    const invalid = await handler(new Request(`${projectUrl}/commits?limit=bogus`));
    expect(invalid.status).toBe(400);
    expect(await json(invalid, S.ApiErrorResponseSchema)).toMatchObject({ error: "invalid limit: bogus" });
  });

  it("comment CRUD — 201/200/204 + shapes", async () => {
    // create → 201, author user, status open
    const created = await handler(new Request(`${projectUrl}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: "a.txt", side: "old", line: 2, lineText: "two", body: "note this" })
    }));
    expect(created.status).toBe(201);
    const comment = await json(created, S.CommentSchema);
    expect(comment).toMatchObject({
      file: "a.txt",
      side: "old",
      line: 2,
      lineText: "two",
      body: "note this",
      author: "user",
      status: "open"
    });
    expect(comment.id).toEqual(expect.any(String));
    expect(comment.createdAt).toEqual(expect.any(Number));

    // list → { comments: [...] }
    const list = await json(await handler(new Request(`${projectUrl}/comments`)), S.ListCommentsResponseSchema);
    expect(list.comments).toHaveLength(1);
    expect(list.comments[0]!.id).toBe(comment.id);

    // list with filters → ok
    const open = await json(await handler(new Request(`${projectUrl}/comments?status=open`)), S.ListCommentsResponseSchema);
    expect(open.comments).toHaveLength(1);

    // patch → 200 + updated fields
    const patched = await handler(new Request(`${projectUrl}/comments/${comment.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "addressed", note: "done" })
    }));
    expect(patched.status).toBe(200);
    expect(await json(patched, S.CommentSchema)).toMatchObject({ status: "addressed", note: "done" });

    // delete → 204, then 404
    const deleted = await handler(new Request(`${projectUrl}/comments/${comment.id}`, { method: "DELETE" }));
    expect(deleted.status).toBe(204);
    const gone = await handler(new Request(`${projectUrl}/comments/${comment.id}`, { method: "DELETE" }));
    expect(gone.status).toBe(404);
  });

  it("PATCH missing id → 404 { error: 'comment not found' }", async () => {
    const res = await handler(new Request(`${projectUrl}/comments/nope`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "addressed" })
    }));
    expect(res.status).toBe(404);
    expect(await json(res, S.ApiErrorResponseSchema)).toMatchObject({ error: "comment not found" });
  });

  it("invalid payloads → 400 with { error: message }", async () => {
    // Malformed JSON body
    const bad1 = await handler(new Request(`${projectUrl}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json"
    }));
    expect(bad1.status).toBe(400);
    expect((await json(bad1, S.ApiErrorResponseSchema)).error).toEqual(expect.any(String));

    // Schema-invalid body (empty file, missing fields)
    const bad2 = await handler(new Request(`${projectUrl}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: "", body: "" })
    }));
    expect(bad2.status).toBe(400);
    expect((await json(bad2, S.ApiErrorResponseSchema)).error).toEqual(expect.any(String));

    // Empty patch object (the "empty patch" refinement)
    const bad3 = await handler(new Request(`${projectUrl}/comments/x`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    }));
    expect(bad3.status).toBe(400);
    expect((await json(bad3, S.ApiErrorResponseSchema)).error).toEqual(expect.any(String));
  });

  it("invalid status query → 400 { error: 'invalid status: bogus' }", async () => {
    const res = await handler(new Request(`${projectUrl}/comments?status=bogus`));
    expect(res.status).toBe(400);
    expect(await json(res, S.ApiErrorResponseSchema)).toMatchObject({ error: "invalid status: bogus" });
  });

  it("unknown /api path → 404 { error: 'not found' }", async () => {
    const res = await handler(new Request("http://localhost/api/definitely-not-a-route"));
    expect(res.status).toBe(404);
    expect(await json(res, S.ApiErrorResponseSchema)).toEqual({ error: "not found" });
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

  it("keeps open comments and saved code after commits, including removed code", async () => {
    const create = async (side: CommentSide, lineText: string) => {
      const res = await handler(new Request(`${projectUrl}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: "a.txt", side, line: 2, lineText, body: "Still needs attention" })
      }));
      expect(res.status).toBe(201);
      return json(res, S.CommentSchema);
    };
    const old = await create("old", "two");
    const added = await create("new", "TWO");
    expect(old.context!.lines).toEqual([
      { line: 1, content: "one" },
      { line: 2, content: "two" },
      { line: 3, content: "three" }
    ]);
    expect(added.context!.lines).toContainEqual({ line: 2, content: "TWO" });

    await git(repoDir, ["add", "."]);
    await git(repoDir, ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "--quiet", "-m", "reviewed change"]);
    const clean = await waitFor(
      async () => json(await handler(new Request(`${projectUrl}/diff`)), S.GetDiffResponseSchema),
      (diff) => diff.files.length === 0
    );
    expect(clean.files).toEqual([]);
    const list = await json(await handler(new Request(`${projectUrl}/comments?status=open`)), S.ListCommentsResponseSchema);
    for (const original of [old, added]) {
      expect(list.comments.find((c) => c.id === original.id)).toMatchObject({
        status: "open", outdated: true, context: original.context
      });
    }

    const unchanged = await create("new", "TWO");
    expect(unchanged.context).toMatchObject({
      source: "snapshot", line: 2,
      lines: expect.arrayContaining([{ line: 1, content: "one" }, { line: 2, content: "TWO" }])
    });
    const recovered = await json(await handler(new Request(`${projectUrl}/comments`)), S.ListCommentsResponseSchema);
    expect(recovered.comments.find((c) => c.id === unchanged.id)).toMatchObject({
      historical: false, outdated: false, context: unchanged.context
    });

    await git(repoDir, ["rm", "a.txt"]);
    await git(repoDir, ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "--quiet", "-m", "remove file"]);
    await waitFor(
      async () => json(await handler(new Request(`${projectUrl}/diff`)), S.GetDiffResponseSchema),
      (diff) => diff.reviewId !== clean.reviewId
    );
    const removed = await json(await handler(new Request(`${projectUrl}/comments?status=open`)), S.ListCommentsResponseSchema);
    expect(removed.comments.find((c) => c.id === old.id)!.context).toEqual(old.context);
    expect(removed.comments.find((c) => c.id === unchanged.id)).toMatchObject({
      status: "open", lineText: "TWO", context: unchanged.context
    });
  });

  it("isolates recurring code by review and carries comments forward only on explicit request", async () => {
    const diff = async () => json(await handler(new Request(`${projectUrl}/diff`)), S.GetDiffResponseSchema);
    const list = async () => json(await handler(new Request(`${projectUrl}/comments`)), S.ListCommentsResponseSchema);
    const patch = async (id: string, body: UpdateCommentRequest) => {
      const res = await handler(new Request(`${projectUrl}/comments/${id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
      }));
      expect(res.status).toBe(200);
      return json(res, S.CommentSchema);
    };
    await writeFile(join(repoDir, "review.txt"), "start\nrepeated\nend\n");
    const first = await waitFor(diff, (d) => d.files.some((f) => f.newPath === "review.txt"));
    const create = async (line: number, lineText: string) => {
      const res = await handler(new Request(`${projectUrl}/comments`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: "review.txt", side: "new", line, lineText, body: "Feedback" })
      }));
      expect(res.status).toBe(201);
      return json(res, S.CommentSchema);
    };
    const open = await create(2, "repeated");
    const firstHead = (await git(repoDir, ["rev-parse", "HEAD"])).stdout.trim();
    expect(open.reviewHead).toBe(firstHead);
    const addressed = await create(2, "repeated");
    const missing = await create(1, "start");
    await patch(addressed.id, { status: "addressed", note: "Already handled" });
    expect(open.reviewId).toBe(first.reviewId);

    // Within one review, moved code still re-anchors and keeps its original excerpt.
    await writeFile(join(repoDir, "review.txt"), "prefix\nstart\nrepeated\nend\n");
    const shifted = await waitFor(list, (l) => l.comments.find((c) => c.id === open.id)?.line === 3);
    expect(shifted.comments.find((c) => c.id === open.id)).toMatchObject({
      historical: false, outdated: false, line: 3, context: open.context
    });

    await git(repoDir, ["add", "."]);
    await git(repoDir, ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "--quiet", "-m", "end review"]);
    const next = await waitFor(diff, (d) => d.reviewId !== first.reviewId);
    expect(next.reviewId).not.toBe(first.reviewId);
    const stale = await handler(new Request(`${projectUrl}/comments`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        reviewId: first.reviewId, file: "review.txt", side: "new", line: 3,
        lineText: "repeated", body: "Submitted from a stale editor"
      })
    }));
    expect(stale.status).toBe(400);
    expect((await json(stale, S.ApiErrorResponseSchema)).error).toContain("review ended");
    await writeFile(join(repoDir, "review.txt"), "prefix\nreplacement\nextra\nrepeated\nend\n");
    await waitFor(diff, (d) => d.files.some((f) => f.newPath === "review.txt"));

    for (const original of [open, addressed]) {
      const comment = (await list()).comments.find((c) => c.id === original.id);
      expect(comment).toMatchObject({
        reviewId: first.reviewId, reviewHead: firstHead, historical: true, outdated: true, line: 3, context: original.context
      });
    }
    // Reopening a historical comment changes status only, not review membership.
    await patch(addressed.id, { status: "open" });
    expect((await list()).comments.find((c) => c.id === addressed.id)!.historical).toBe(true);
    await patch(addressed.id, { status: "addressed" });

    const carried = await patch(addressed.id, { carryForward: true });
    expect(carried.reviewHead).toBe((await git(repoDir, ["rev-parse", "HEAD"])).stdout.trim());
    expect(carried).toMatchObject({
      reviewId: next.reviewId, status: "addressed", note: "Already handled", line: 4,
      context: { source: "snapshot", line: 4 }
    });
    const after = (await list()).comments;
    expect(after.find((c) => c.id === addressed.id)).toMatchObject({ historical: false, outdated: false });
    expect(after.find((c) => c.id === open.id)).toMatchObject({ historical: true, status: "open", line: 3 });

    // Carry-forward is also allowed when the original anchor no longer exists.
    await patch(missing.id, { carryForward: true });
    expect((await list()).comments.find((c) => c.id === missing.id)).toMatchObject({
      reviewId: next.reviewId, historical: false, outdated: true, context: missing.context
    });
  });
});

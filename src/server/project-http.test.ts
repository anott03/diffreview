import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Layer, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiRoutes, apiNotFoundRoutes, projectServices } from "./http";
import * as S from "./api-schemas";
import type { CreateCommentRequest, Project } from "../shared/types";

const exec = promisify(execFile);
const git = (cwd: string, args: string[]) => exec("git", args, { cwd });
const commit = (cwd: string) => git(cwd, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-am", "change", "--quiet"]);
const decode = async <A, I>(response: Response, schema: Schema.Codec<A, I>): Promise<A> =>
  Schema.decodeUnknownSync(schema)(await response.json());

let directory: string;
let repos: string[];
let projects: Project[];
let app: ReturnType<typeof makeApp>;
const makeApp = () => HttpRouter.toWebHandler(Layer.mergeAll(ApiRoutes, apiNotFoundRoutes).pipe(Layer.provide([
  HttpServer.layerServices,
  projectServices({ port: 0, intervalMs: 20, webRoot: null, instanceId: "multi-project-test", startedAt: 123 }, join(directory, "data", "projects.sqlite"))
])));
const request = (path: string, init?: RequestInit) => app.handler(new Request(`http://localhost/api${path}`, init));
const scoped = (project: Project, path: string, init?: RequestInit) => request(`/projects/${project.id}${path}`, init);
const open = async (path: string) => decode(await request("/projects", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path })
}), S.ProjectSchema);
const create = async (project: Project, body: string) => {
  const input: CreateCommentRequest = { file: "same.txt", side: "new", line: 1, lineText: body, body };
  const response = await scoped(project, "/comments", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input)
  });
  expect(response.status).toBe(201);
  return decode(response, S.CommentSchema);
};

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "diffreview-project-http-"));
  repos = [join(directory, "a"), join(directory, "b")];
  for (const [i, root] of repos.entries()) {
    await mkdir(root);
    await git(root, ["init", "--quiet"]);
    await writeFile(join(root, "same.txt"), "original\n");
    await git(root, ["add", "."]);
    await commit(root);
    await writeFile(join(root, "same.txt"), `project-${i}\n`);
  }
  app = makeApp();
  projects = await Promise.all(repos.map(open));
});

afterAll(async () => {
  await app.dispose();
  await rm(directory, { recursive: true, force: true });
});

describe("project-scoped HTTP", () => {
  it("reports global identity and rejects unscoped and unknown project routes", async () => {
    expect(await decode(await request("/server"), S.ServerInfoSchema)).toEqual({
      service: "diffreview", protocolVersion: 1, instanceId: "multi-project-test", pid: process.pid, startedAt: 123
    });
    expect((await decode(await request("/projects"), S.ListProjectsResponseSchema)).projects).toHaveLength(2);
    for (const path of ["/meta", "/diff", "/comments", "/files", "/file?path=same.txt", "/projects/nope/meta", "/projects/nope/diff", "/projects/nope/comments", "/projects/nope/files", "/projects/nope/file?path=same.txt"]) {
      expect((await request(path)).status).toBe(404);
    }
    for (const path of ["", "   ", directory, join(directory, "missing")]) {
      const response = await request("/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) });
      expect(response.status).toBe(400);
      expect((await decode(response, S.ApiErrorResponseSchema)).error.length).toBeGreaterThan(0);
    }
  });

  it("isolates current file listings and content, rejecting unlisted files and escaping paths", async () => {
    const a = projects[0]!;
    const b = projects[1]!;
    await writeFile(join(repos[0]!, "only-a.txt"), "private to a\n");
    await writeFile(join(repos[0]!, ".gitignore"), "ignored.txt\n");
    await writeFile(join(repos[0]!, "ignored.txt"), "ignored secret\n");
    await symlink(repos[1]!, join(repos[0]!, "other-project"));
    try {
      for (const [i, project] of projects.entries()) {
        const response = await scoped(project, "/files");
        expect(response.status).toBe(200);
        const { files } = await decode(response, S.ListFilesResponseSchema);
        expect(files).toContain("same.txt");
        expect(files.includes("only-a.txt")).toBe(i === 0);
        expect(files).not.toContain("ignored.txt");
        expect(files.some((file) => file.startsWith(".git/"))).toBe(false);
        expect(await decode(await scoped(project, "/file?path=same.txt"), S.FileContentSchema)).toEqual({
          path: "same.txt", kind: "text", content: `project-${i}\n`
        });
      }
      expect((await scoped(b, "/file?path=only-a.txt")).status).toBe(404);
      for (const path of ["ignored.txt", "missing.txt", "other-project/same.txt"]) {
        expect((await scoped(a, `/file?${new URLSearchParams({ path })}`)).status).toBe(404);
      }
      for (const path of ["", "../b/same.txt", join(repos[1]!, "same.txt"), ".git/config", "other-project/../same.txt"]) {
        expect((await scoped(a, `/file?${new URLSearchParams({ path })}`)).status).toBe(400);
      }
      expect((await scoped(a, "/file")).status).toBe(400);
      expect(await decode(await scoped(a, "/file?path=other-project"), S.FileContentSchema)).toEqual({
        path: "other-project", kind: "symlink", content: repos[1]
      });
    } finally {
      for (const path of ["only-a.txt", ".gitignore", "ignored.txt", "other-project"]) {
        await rm(join(repos[0]!, path), { force: true });
      }
    }
  });

  it("isolates matching file paths, comment IDs, review transitions, and persisted history", async () => {
    const a = projects[0]!;
    const b = projects[1]!;
    for (const [i, project] of projects.entries()) {
      expect((await decode(await scoped(project, "/meta"), S.MetaSchema)).repoRoot).toBe(repos[i]);
      const diff = await decode(await scoped(project, "/diff"), S.GetDiffResponseSchema);
      expect(diff.files[0]!.hunks[0]!.lines).toContainEqual(expect.objectContaining({ type: "add", content: `project-${i}` }));
    }
    const beforeA = await decode(await scoped(a, "/diff"), S.GetDiffResponseSchema);
    const beforeB = await decode(await scoped(b, "/diff"), S.GetDiffResponseSchema);
    const commentA = await create(a, "project-0");
    const commentB = await create(b, "project-1");
    for (const method of ["PATCH", "DELETE"]) {
      const init: RequestInit = { method };
      if (method === "PATCH") {
        init.headers = { "content-type": "application/json" };
        init.body = JSON.stringify({ status: "addressed" });
      }
      expect((await scoped(b, `/comments/${commentA.id}`, init)).status).toBe(404);
    }
    expect((await scoped(a, `/comments/${commentA.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "addressed" })
    })).status).toBe(200);
    expect((await decode(await scoped(b, "/comments"), S.ListCommentsResponseSchema)).comments).toEqual([
      expect.objectContaining({ id: commentB.id, status: "open", historical: false })
    ]);
    await commit(repos[0]!);
    const stale = await scoped(a, "/comments", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ reviewId: beforeA.reviewId, file: "same.txt", side: "new", line: 1, lineText: "project-0", body: "stale" })
    });
    expect(stale.status).toBe(400);
    const afterA = await decode(await scoped(a, "/diff"), S.GetDiffResponseSchema);
    expect(afterA.reviewId).not.toBe(beforeA.reviewId);
    expect((await decode(await scoped(b, "/diff"), S.GetDiffResponseSchema)).reviewId).toBe(beforeB.reviewId);
    await app.dispose();
    app = makeApp();
    expect((await decode(await request("/projects"), S.ListProjectsResponseSchema)).projects.map((p) => p.id).sort()).toEqual(projects.map((p) => p.id).sort());
    expect((await decode(await scoped(a, "/comments"), S.ListCommentsResponseSchema)).comments).toEqual([
      expect.objectContaining({ id: commentA.id, status: "addressed", historical: true, reviewId: beforeA.reviewId, context: commentA.context })
    ]);
    expect((await decode(await scoped(a, "/diff"), S.GetDiffResponseSchema)).reviewId).toBe(afterA.reviewId);
    expect((await decode(await scoped(b, "/diff"), S.GetDiffResponseSchema)).reviewId).toBe(beforeB.reviewId);
  });

  it("keeps catalog entries when working trees disappear and recovers without affecting other projects", async () => {
    const a = projects[0]!;
    const b = projects[1]!;
    const root = repos[0]!;
    await rename(root, `${root}-away`);
    try {
      const unavailable = await scoped(a, "/diff");
      expect(unavailable.status).toBe(503);
      expect((await decode(unavailable, S.ApiErrorResponseSchema)).error).toContain(root);
      await app.dispose();
      app = makeApp();
      expect((await scoped(a, "/diff")).status).toBe(503);
      expect((await scoped(a, "/files")).status).toBe(503);
      expect((await scoped(a, "/file?path=same.txt")).status).toBe(503);
      expect((await scoped(b, "/files")).status).toBe(200);
      expect((await scoped(b, "/file?path=same.txt")).status).toBe(200);
      expect((await scoped(b, "/diff")).status).toBe(200);
      expect((await decode(await request("/projects"), S.ListProjectsResponseSchema)).projects).toHaveLength(2);
    } finally {
      await rename(`${root}-away`, root);
    }
    expect((await scoped(a, "/diff")).status).toBe(200);
  });

  it("multiplexes project mutations and catalog invalidations over one SSE connection", async () => {
    const abort = new AbortController();
    const response = await request("/events", { signal: abort.signal });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const frames: string[] = [];
    const reading = (async () => {
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          frames.push(decoder.decode(chunk.value));
        }
      } catch {
        if (!abort.signal.aborted) throw new Error("SSE read failed");
      }
    })();
    try {
      await create(projects[0]!, "sse-a");
      await create(projects[1]!, "sse-b");
      await open(repos[0]!);
      const deadline = Date.now() + 2000;
      while ((!frames.join("").includes('"type":"projects"') || projects.some((p) => !frames.join("").includes(`"projectId":"${p.id}"`))) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const text = frames.join("");
      expect(text).toContain("event: projects");
      for (const project of projects) {
        const payloads = text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => Schema.decodeUnknownSync(Schema.fromJsonString(S.SseEventSchema))(line.slice(6)));
        expect(payloads).toContainEqual(expect.objectContaining({ type: "comments", projectId: project.id }));
      }
    } finally {
      abort.abort();
      await reader.cancel();
      await reading;
    }
  });
});

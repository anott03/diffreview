import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectApi, globalApi, subscribeServerEvents } from "./api";
import type { Comment, Meta } from "../shared/types";

const comment: Comment = {
  id: "same-id", file: "same.ts", side: "new", line: 1, lineText: "code", body: "Review this",
  author: "user", status: "open", createdAt: 1, updatedAt: 1,
};
const meta: Meta = { repoRoot: "/a", branch: "main", head: "abc", files: 0, additions: 0, deletions: 0 };

afterEach(() => vi.unstubAllGlobals());

describe("project-bound requests", () => {
  it("keeps overlapping comments isolated after another client is created", async () => {
    const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (path.endsWith("/meta")) return Response.json(meta);
      if (path.endsWith("/diff")) return Response.json({ files: [], reviewId: "review-a" });
      if (path.endsWith("?status=all")) return Response.json({ comments: [comment] });
      return Response.json(comment);
    });
    vi.stubGlobal("fetch", fetcher);
    const a = createProjectApi("project/a");
    const b = createProjectApi("project-b");
    const controller = new AbortController();
    await a.getMeta(controller.signal);
    await a.getDiff();
    await b.getComments();
    await a.createComment({ file: "same.ts", side: "new", line: 1, lineText: "code", body: "Review this", reviewId: "review-a" });
    await b.updateComment("same/id", { status: "addressed" });
    await a.deleteComment("same/id");
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
      "/api/projects/project%2Fa/meta",
      "/api/projects/project%2Fa/diff",
      "/api/projects/project-b/comments?status=all",
      "/api/projects/project%2Fa/comments",
      "/api/projects/project-b/comments/same%2Fid",
      "/api/projects/project%2Fa/comments/same%2Fid",
    ]);
    expect(fetcher.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    expect(fetcher.mock.calls[3]?.[1]?.body).toContain('"reviewId":"review-a"');
  });

  it("binds file browsing to the project and encodes file paths without losing special characters", async () => {
    const path = "src/a #?&é.ts";
    const fetcher = vi.fn(async (url: string, _init?: RequestInit) => url.endsWith("/files")
      ? Response.json({ files: [path] })
      : Response.json({ path, content: "code\n", kind: "text" }));
    vi.stubGlobal("fetch", fetcher);
    const api = createProjectApi("project/a");
    const controller = new AbortController();
    expect(await api.getFiles(controller.signal)).toEqual({ files: [path] });
    expect(await api.getFile(path, controller.signal)).toEqual({ path, content: "code\n", kind: "text" });
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/projects/project%2Fa/files");
    const url = new URL(fetcher.mock.calls[1]![0], "http://localhost");
    expect(url.pathname).toBe("/api/projects/project%2Fa/file");
    expect(url.searchParams.get("path")).toBe(path);
    expect(fetcher.mock.calls.every(([, init]) => init?.signal === controller.signal)).toBe(true);
  });

  it("rejects invalid file browsing responses", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ files: [123], path: "a", kind: "html", content: null }));
    const api = createProjectApi("a");
    await expect(api.getFiles()).rejects.toThrow();
    await expect(api.getFile("a")).rejects.toThrow();
  });

  it("binds commit history endpoints to the project and encodes commit ids", async () => {
    const fetcher = vi.fn(async (url: string, _init?: RequestInit) => url.includes("/commits/")
      ? Response.json({ files: [] })
      : Response.json({ commits: [] }));
    vi.stubGlobal("fetch", fetcher);
    const api = createProjectApi("project/a");
    const controller = new AbortController();
    expect(await api.getCommits(200, 0, controller.signal)).toEqual({ commits: [] });
    expect(await api.getCommitDiff("abc123", controller.signal)).toEqual({ files: [] });
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/projects/project%2Fa/commits?limit=200&offset=0");
    expect(fetcher.mock.calls[1]?.[0]).toBe("/api/projects/project%2Fa/commits/abc123/diff");
    expect(fetcher.mock.calls.every(([, init]) => init?.signal === controller.signal)).toBe(true);
  });

  it("surfaces unavailable project errors rather than returning empty data", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ error: "Working tree is missing" }, { status: 503 }));
    await expect(createProjectApi("missing").getDiff()).rejects.toThrow("Working tree is missing");
  });

  it("validates global responses and sends paths only to project registration", async () => {
    const project = { id: "a", root: "/a", name: "a", openedAt: 1 };
    const fetcher = vi.fn(async () => Response.json(project));
    vi.stubGlobal("fetch", fetcher);
    expect(await globalApi.openProject("/a")).toEqual(project);
    expect(fetcher).toHaveBeenCalledWith("/api/projects", expect.objectContaining({ method: "POST", body: '{"path":"/a"}' }));
    await expect(globalApi.getProjects()).rejects.toThrow();
  });
});

class BrowserEventSource extends EventTarget {
  static instances: BrowserEventSource[] = [];
  closed = false;
  constructor(readonly url: string) {
    super();
    BrowserEventSource.instances.push(this);
  }
  close() { this.closed = true; }
}

describe("global server events", () => {
  it("routes project and catalog events through one connection and refreshes on every open", () => {
    BrowserEventSource.instances = [];
    vi.stubGlobal("EventSource", BrowserEventSource);
    const handlers = { onProject: vi.fn(), onProjects: vi.fn(), onConnect: vi.fn(), onDisconnect: vi.fn() };
    const stop = subscribeServerEvents(handlers);
    expect(BrowserEventSource.instances).toHaveLength(1);
    const source = BrowserEventSource.instances[0]!;
    expect(source.url).toBe("/api/events");
    source.dispatchEvent(new Event("open"));
    source.dispatchEvent(new MessageEvent("diff", { data: JSON.stringify({ type: "diff", projectId: "a", at: 1 }) }));
    source.dispatchEvent(new MessageEvent("comments", { data: JSON.stringify({ type: "comments", projectId: "b", at: 2 }) }));
    source.dispatchEvent(new MessageEvent("projects", { data: JSON.stringify({ type: "projects", at: 3 }) }));
    source.dispatchEvent(new MessageEvent("diff", { data: "{" }));
    source.dispatchEvent(new MessageEvent("comments", { data: JSON.stringify({ type: "comments", at: 4 }) }));
    source.dispatchEvent(new Event("error"));
    source.dispatchEvent(new Event("open"));
    expect(handlers.onProject.mock.calls).toEqual([["a"], ["b"]]);
    expect(handlers.onProjects).toHaveBeenCalledTimes(1);
    expect(handlers.onDisconnect).toHaveBeenCalledTimes(1);
    expect(handlers.onConnect).toHaveBeenCalledTimes(2);
    stop();
    expect(source.closed).toBe(true);
  });
});

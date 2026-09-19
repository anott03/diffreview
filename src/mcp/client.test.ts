import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { writeServerDescriptor, type ServerDescriptor } from "../server/server-discovery";
import { resolveProjectPath } from "../server/project-path";
import { apiGet, apiPatch, resolveClient } from "./client";

let directory: string;
let previousDataHome: string | undefined;
let server: Server | undefined;
const registeredPaths: string[] = [];

beforeEach(() => {
  registeredPaths.length = 0;
  previousDataHome = process.env.XDG_DATA_HOME;
  directory = mkdtempSync(join(tmpdir(), "diffreview-mcp-"));
  process.env.XDG_DATA_HOME = join(directory, "data");
});

afterEach(async () => {
  if (server) await new Promise<void>((done) => server?.close(() => done()));
  server = undefined;
  if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previousDataHome;
  rmSync(directory, { recursive: true, force: true });
});

function repository(name: string): string {
  const root = join(directory, name);
  mkdirSync(root);
  execFileSync("git", ["init", "-q", root]);
  return root;
}

async function startServer(roots: string[], wrongRoot = false): Promise<ServerDescriptor> {
  const info = {
    service: "diffreview",
    protocolVersion: 1,
    instanceId: "mcp-test-server",
    pid: process.pid,
    startedAt: Date.now(),
  } as const;
  const statuses = new Map(roots.map((_, index) => [String(index), "open"]));
  server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/server") {
      response.end(JSON.stringify(info));
      return;
    }
    if (request.method === "POST" && request.url === "/api/projects") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(z.instanceof(Buffer).parse(chunk));
      const input = z.object({ path: z.string() }).parse(JSON.parse(Buffer.concat(chunks).toString()));
      registeredPaths.push(input.path);
      const root = await resolveProjectPath(input.path);
      const index = roots.indexOf(root);
      if (index < 0) {
        response.statusCode = 400;
        response.end(JSON.stringify({ error: "Unknown working tree" }));
        return;
      }
      response.end(JSON.stringify({ id: String(index), root: wrongRoot ? "/wrong-repository" : root, name: `Project ${index}`, openedAt: Date.now() }));
      return;
    }
    const match = /^\/api\/projects\/(\d+)\/comments(?:\/([^?]+))?(?:\?.*)?$/.exec(request.url ?? "");
    if (match) {
      const projectId = match[1] ?? "";
      if (request.method === "PATCH") {
        if (match[2] !== "same-id") {
          response.statusCode = 404;
          response.end("{}");
          return;
        }
        statuses.set(projectId, "addressed");
      }
      response.end(JSON.stringify({ id: "same-id", status: statuses.get(projectId) }));
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  await new Promise<void>((done) => server?.listen(0, "127.0.0.1", done));
  const address = z.object({ port: z.number() }).parse(server.address());
  const descriptor = { ...info, endpoint: `http://127.0.0.1:${address.port}` };
  writeServerDescriptor(descriptor);
  return descriptor;
}

const ReviewStatusSchema = z.object({ id: z.string(), status: z.enum(["open", "addressed"]) });

describe("project-bound MCP client", () => {
  it("registers cwd projects without a browser and keeps reads and mutations isolated", async () => {
    const firstRoot = repository("first");
    const secondRoot = repository("second");
    mkdirSync(join(firstRoot, "nested"));
    await startServer([firstRoot, secondRoot]);
    const first = await resolveClient(join(firstRoot, "nested"));
    const second = await resolveClient(secondRoot);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("Project resolution failed");
    expect(first.client.repoRoot).toBe(firstRoot);
    expect(first.client.baseUrl).toBe(second.client.baseUrl);
    expect(first.client.project.id).not.toBe(second.client.project.id);
    expect(Object.isFrozen(first.client.project)).toBe(true);
    expect(await apiPatch(first.client, "/comments/same-id", { status: "addressed" }, ReviewStatusSchema))
      .toEqual({ id: "same-id", status: "addressed" });
    expect(await apiGet(second.client, "/comments?status=all", ReviewStatusSchema))
      .toEqual({ id: "same-id", status: "open" });
    expect(await apiGet(first.client, "/comments?status=all", ReviewStatusSchema))
      .toEqual({ id: "same-id", status: "addressed" });
    expect(await apiPatch(first.client, "/comments/missing", { status: "addressed" }, ReviewStatusSchema)).toBeNull();
  });

  it("registers the absolute alias input while binding to the canonical project root", async () => {
    const root = repository("repo");
    mkdirSync(join(root, "nested"));
    const alias = join(directory, "alias");
    symlinkSync(root, alias);
    await startServer([root]);
    const input = join(alias, "nested");
    const result = await resolveClient(relative(process.cwd(), input));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(registeredPaths).toEqual([input]);
    expect(result.client.repoRoot).toBe(root);
    expect(result.client.project.root).toBe(root);
  });

  it("keeps aliases in launcher instructions when discovery is absent", async () => {
    const root = repository("repo");
    const alias = join(directory, "alias");
    symlinkSync(root, alias);
    const result = await resolveClient(relative(process.cwd(), alias));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Unexpected connection");
    expect(result.error).toContain(`diffreview open ${JSON.stringify(alias)} --no-open`);
  });

  it("does not auto-start and gives launcher instructions when discovery is absent", async () => {
    const root = repository("repo");
    const result = await resolveClient(root);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Unexpected connection");
    expect(result.error).toContain("diffreview open");
    expect(result.error).toContain("--no-open");
  });

  it("rejects stale server identity before registering a project", async () => {
    const root = repository("repo");
    const descriptor = await startServer([root]);
    writeServerDescriptor({ ...descriptor, instanceId: "old-instance" });
    const result = await resolveClient(root);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Unexpected connection");
    expect(result.error).toContain("No verified global");
  });

  it("rejects a project registration for a different repository", async () => {
    const root = repository("repo");
    await startServer([root], true);
    const result = await resolveClient(root);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Unexpected connection");
    expect(result.error).toContain("different working tree");
  });

  it("rejects an invocation outside a Git working tree", async () => {
    const result = await resolveClient(directory);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Unexpected connection");
    expect(result.error).toContain("Git working tree");
  });
});

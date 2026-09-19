import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ListCommentsResponseSchema, ListProjectsResponseSchema } from "../shared/response-schemas";
import { dataDir, repoHash } from "./paths";
import { CommentStore } from "./store";
import { acquireServerLock, discoverServer, readServerDescriptor, serverLogPath, writeServerDescriptor, type ServerDescriptor } from "./server-discovery";

const entryPath = resolve("src/server/cli.ts");
const tsxLoader = import.meta.resolve("tsx");
let directory: string;
let previousDataHome: string | undefined;
const children: ChildProcess[] = [];

beforeEach(() => {
  previousDataHome = process.env.XDG_DATA_HOME;
  directory = mkdtempSync(join(tmpdir(), "diffreview-launcher-"));
  process.env.XDG_DATA_HOME = join(directory, "data");
});

afterEach(async () => {
  const server = readServerDescriptor();
  if (server && server.pid !== process.pid) {
    try { process.kill(server.pid, "SIGTERM"); } catch { /* The process may have already exited. */ }
    const deadline = Date.now() + 5000;
    while (readServerDescriptor() && Date.now() < deadline) await sleep(50);
    if (readServerDescriptor()) {
      try { process.kill(server.pid, "SIGKILL"); } catch { /* The process may have already exited. */ }
    }
  }
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise<void>((done) => child.once("exit", () => done()));
    }
  }
  if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previousDataHome;
  rmSync(directory, { recursive: true, force: true });
});

function runCli(args: string[]) {
  const child = spawn(process.execPath, ["--import", tsxLoader, entryPath, ...args], {
    cwd: directory,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const exited = new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => done({ code, stdout, stderr }));
  });
  return { child, exited };
}

function repository(name: string): string {
  const root = join(directory, name);
  mkdirSync(root);
  execFileSync("git", ["init", "-q", root]);
  return root;
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = z.object({ port: z.number() }).parse(server.address());
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

async function ready(): Promise<ServerDescriptor> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const descriptor = await discoverServer();
    if (descriptor) return descriptor;
    await sleep(100);
  }
  throw new Error("Server did not publish a ready descriptor");
}

async function projects(server: ServerDescriptor) {
  const response = await fetch(`${server.endpoint}/api/projects`);
  return ListProjectsResponseSchema.parse(await response.json()).projects;
}

describe("global launcher", () => {
  it("serves outside Git, opens two projects in one process, and rejects a conflicting port", async () => {
    const port = await availablePort();
    const foreground = runCli(["serve", "--port", String(port)]);
    const server = await ready();
    expect(server.pid).toBe(foreground.child.pid);
    expect(await projects(server)).toEqual([]);
    const first = await runCli(["open", repository("first"), "--no-open"]).exited;
    const second = await runCli([repository("second"), "--no-open"]).exited;
    expect(first.code, first.stderr).toBe(0);
    expect(second.code, second.stderr).toBe(0);
    expect(first.stdout).toContain(`${server.endpoint}/projects/`);
    expect(second.stdout).toContain(`${server.endpoint}/projects/`);
    expect(first.stdout).not.toBe(second.stdout);
    expect(await projects(server)).toHaveLength(2);
    expect((await discoverServer())?.pid).toBe(server.pid);
    const conflicting = await runCli(["open", join(directory, "first"), "--no-open", "--port", String(port === 65535 ? 65534 : port + 1)]).exited;
    expect(conflicting.code).toBe(1);
    expect(conflicting.stderr).toContain("Omit --port to attach");
    foreground.child.kill("SIGTERM");
    await foreground.exited;
    expect(readServerDescriptor()).toBeNull();
  }, 30_000);

  it("concurrent detached launchers recover stale discovery and converge on one server", async () => {
    const port = await availablePort();
    writeServerDescriptor({
      service: "diffreview", protocolVersion: 1, instanceId: "stale", pid: process.pid,
      startedAt: 1, endpoint: `http://127.0.0.1:${port}`,
    });
    const [first, second] = await Promise.all([
      runCli(["open", repository("first"), "--no-open", "--port", String(port)]).exited,
      runCli(["open", repository("second"), "--no-open", "--port", String(port)]).exited,
    ]);
    expect(first.code, first.stderr).toBe(0);
    expect(second.code, second.stderr).toBe(0);
    const server = await ready();
    expect(server.instanceId).not.toBe("stale");
    expect(await projects(server)).toHaveLength(2);
    expect(first.stdout).toContain(server.endpoint);
    expect(second.stdout).toContain(server.endpoint);
    expect(await discoverServer()).toEqual(server);
  }, 30_000);

  it("opens a relative alias subdirectory without losing legacy history when no session exists", async () => {
    const root = repository("repo");
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "file.txt"), "review me\n");
    const alias = join(directory, "alias");
    symlinkSync(root, alias);
    const legacyPath = join(dataDir(), `${repoHash(alias)}.sqlite`);
    const saved = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const store = yield* CommentStore;
      const reviewId = yield* store.currentReview("");
      return yield* store.create({ reviewId, file: "file.txt", side: "new", line: 1, lineText: "review me", body: "legacy", author: "user" });
    }).pipe(Effect.provide(CommentStore.layer(legacyPath)))));
    expect(existsSync(join(dataDir(), "sessions"))).toBe(false);
    const port = await availablePort();
    const result = await runCli(["open", "alias/nested", "--no-open", "--port", String(port)]).exited;
    expect(result.code, result.stderr).toBe(0);
    const server = await ready();
    const registered = await projects(server);
    expect(registered).toEqual([expect.objectContaining({ id: repoHash(root), root })]);
    const response = await fetch(`${server.endpoint}/api/projects/${repoHash(root)}/comments`);
    const comments = ListCommentsResponseSchema.parse(await response.json());
    expect(comments.comments).toEqual([expect.objectContaining({ id: saved.id, reviewId: saved.reviewId, historical: false })]);
    expect(existsSync(join(dataDir(), `${repoHash(root)}.sqlite`))).toBe(false);
  }, 30_000);

  it("relaunches after a departing server releases its startup lock", async () => {
    const lock = await acquireServerLock();
    if (!lock) throw new Error("Could not acquire departing server lock");
    try {
      const port = await availablePort();
      const launcher = runCli(["open", repository("repo"), "--no-open", "--port", String(port)]);
      await expect.poll(() => existsSync(serverLogPath()) ? readFileSync(serverLogPath(), "utf8") : "", { timeout: 10_000 })
        .toContain("Another global server is starting or running");
      expect(readServerDescriptor()).toBeNull();
      lock.release();
      const result = await launcher.exited;
      expect(result.code, result.stderr).toBe(0);
      const server = await ready();
      expect(result.stdout).toContain(server.endpoint);
      expect(await projects(server)).toHaveLength(1);
      expect(await acquireServerLock()).toBeNull();
    } finally {
      lock.release();
    }
  }, 30_000);

  it("reports an unrelated occupied port without publishing discovery", async () => {
    const occupied = createServer((_request, response) => response.end("not diffreview"));
    await new Promise<void>((done) => occupied.listen(0, "127.0.0.1", done));
    try {
      const { port } = z.object({ port: z.number() }).parse(occupied.address());
      const result = await runCli(["serve", "--port", String(port)]).exited;
      expect(result.code).not.toBe(0);
      expect(`${result.stderr}${result.stdout}`).toContain("already in use");
      expect(readServerDescriptor()).toBeNull();
    } finally {
      await new Promise<void>((done) => occupied.close(() => done()));
    }
  }, 15_000);

  it("rejects malformed ports before starting a server", async () => {
    const result = await runCli(["serve", "--port", "4777oops"]).exited;
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Invalid port");
    expect(readServerDescriptor()).toBeNull();
  }, 10_000);
});

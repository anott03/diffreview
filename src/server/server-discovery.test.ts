import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  acquireServerLock,
  checkServerPort,
  clearServerDescriptor,
  discoverServer,
  ensureServer,
  readServerDescriptor,
  serverDescriptorPath,
  serverLogPath,
  verifyServer,
  writeServerDescriptor,
  type ServerDescriptor,
} from "./server-discovery";

let dataHome: string;
let previousDataHome: string | undefined;
const servers: Server[] = [];

beforeEach(() => {
  previousDataHome = process.env.XDG_DATA_HOME;
  dataHome = mkdtempSync(join(tmpdir(), "diffreview-discovery-"));
  process.env.XDG_DATA_HOME = dataHome;
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previousDataHome;
  rmSync(dataHome, { recursive: true, force: true });
});

function descriptor(endpoint = "http://127.0.0.1:4777"): ServerDescriptor {
  return {
    service: "diffreview",
    protocolVersion: 1,
    instanceId: "test-instance",
    pid: process.pid,
    startedAt: 1700000000000,
    endpoint,
  };
}

async function identityServer(payload: string): Promise<string> {
  const server = createServer((request, response) => {
    if (request.url !== "/api/server") response.statusCode = 404;
    response.setHeader("content-type", "application/json");
    response.end(payload);
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = z.object({ port: z.number() }).parse(server.address());
  return `http://127.0.0.1:${address.port}`;
}

describe("global server discovery", () => {
  it("publishes a descriptor and only clears its owner's descriptor", () => {
    const first = descriptor();
    writeServerDescriptor(first);
    expect(readServerDescriptor()).toEqual(first);
    const next = { ...first, instanceId: "next-instance" };
    writeServerDescriptor(next);
    clearServerDescriptor(first.instanceId);
    expect(readServerDescriptor()).toEqual(next);
    clearServerDescriptor(next.instanceId);
    clearServerDescriptor(next.instanceId);
    expect(readServerDescriptor()).toBeNull();
  });

  it("ignores missing, corrupt, and non-loopback descriptors", async () => {
    expect(await discoverServer()).toBeNull();
    writeServerDescriptor(descriptor());
    writeFileSync(serverDescriptorPath(), "{ broken");
    expect(await discoverServer()).toBeNull();
    writeFileSync(serverDescriptorPath(), JSON.stringify({ ...descriptor(), endpoint: "https://example.com" }));
    expect(readServerDescriptor()).toBeNull();
  });

  it("checks identity over HTTP rather than trusting PID liveness", async () => {
    const endpoint = await identityServer(JSON.stringify(descriptor()));
    const info = descriptor(endpoint);
    writeServerDescriptor(info);
    expect(await discoverServer()).toEqual(info);
    expect(await verifyServer({ ...info, instanceId: "stale" })).toBe(false);
    expect(await verifyServer({ ...info, pid: process.pid + 1 })).toBe(false);
    expect(await verifyServer({ ...info, startedAt: info.startedAt + 1 })).toBe(false);
  });

  it("does not adopt an unrelated occupied port or incompatible protocol", async () => {
    const unrelated = await identityServer(JSON.stringify({ ...descriptor(), service: "another-service" }));
    expect(await verifyServer(descriptor(unrelated))).toBe(false);
    const incompatible = await identityServer(JSON.stringify({ ...descriptor(), protocolVersion: 2 }));
    expect(await verifyServer(descriptor(incompatible))).toBe(false);
  });

  it("attaches without a port override and rejects an explicit conflicting port", () => {
    expect(() => checkServerPort(descriptor())).not.toThrow();
    expect(() => checkServerPort(descriptor(), 4777)).not.toThrow();
    expect(() => checkServerPort(descriptor(), 4888)).toThrow("Omit --port to attach");
  });

  it("elects one owner across concurrent startup attempts and permits retry", async () => {
    const locks = await Promise.all(Array.from({ length: 8 }, () => acquireServerLock()));
    try {
      expect(locks.filter(Boolean)).toHaveLength(1);
    } finally {
      locks.forEach((lock) => lock?.release());
    }
    const next = await acquireServerLock();
    expect(next).not.toBeNull();
    next?.release();
    next?.release();
  });

  it("bounds failed relaunches by a cooldown and deadline while retaining startup logs", async () => {
    const entryPath = join(dataHome, "failed-start.mjs");
    writeFileSync(entryPath, 'console.error(`failed-start:${Date.now()}`); process.exitCode = 1;');
    const started = Date.now();
    await expect(ensureServer({ entryPath, timeoutMs: 2000 }))
      .rejects.toThrow(`Logs: ${serverLogPath()}\n`);
    const attempts = [...readFileSync(serverLogPath(), "utf8").matchAll(/failed-start:(\d+)/g)]
      .map((match) => Number(match[1]));
    expect(attempts.length).toBeGreaterThan(1);
    expect(attempts.length).toBeLessThanOrEqual(4);
    for (let index = 1; index < attempts.length; index++) {
      expect(attempts[index]! - attempts[index - 1]!).toBeGreaterThanOrEqual(500);
    }
    expect(Date.now() - started).toBeLessThan(4000);
    expect(readServerDescriptor()).toBeNull();
  }, 5000);

  it("recovers the startup lock after its owning process is killed", async () => {
    const modulePath = resolve("src/server/server-discovery.ts");
    const script = `import {acquireServerLock} from ${JSON.stringify(modulePath)}; const lock = await acquireServerLock(); if (!lock) process.exit(2); console.log('locked'); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exit = once(child, "exit");
    try {
      await once(child.stdout, "data");
      expect(await acquireServerLock()).toBeNull();
      child.kill("SIGKILL");
      await exit;
      const recovered = await acquireServerLock();
      expect(recovered).not.toBeNull();
      recovered?.release();
    } finally {
      child.kill("SIGKILL");
    }
  }, 10_000);
});

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { ProjectSchema, ServerInfoSchema } from "../shared/response-schemas";
import type { Project, ServerInfo } from "../shared/types";
import { dataDir } from "./paths";

const EndpointSchema = z.string().url().refine((endpoint) => {
  const url = new URL(endpoint);
  return url.protocol === "http:" && url.hostname === "127.0.0.1" &&
    url.pathname === "/" && !url.username && !url.password && !url.search && !url.hash;
}, "Expected a loopback HTTP endpoint").transform((endpoint) => new URL(endpoint).origin);

export const ServerDescriptorSchema = ServerInfoSchema.extend({
  instanceId: z.string().min(1),
  pid: z.number().int().positive(),
  startedAt: z.number().int().nonnegative(),
  endpoint: EndpointSchema,
});

export interface ServerDescriptor extends ServerInfo {
  endpoint: string;
}

export function serverDescriptorPath(): string {
  return join(dataDir(), "server.json");
}

export function serverLogPath(): string {
  return join(dataDir(), "server.log");
}

export function readServerDescriptor(): ServerDescriptor | null {
  try {
    return ServerDescriptorSchema.parse(JSON.parse(readFileSync(serverDescriptorPath(), "utf8")));
  } catch {
    return null;
  }
}

export function writeServerDescriptor(descriptor: ServerDescriptor): void {
  const info = ServerDescriptorSchema.parse(descriptor);
  mkdirSync(dataDir(), { recursive: true });
  const temporary = `${serverDescriptorPath()}.${info.instanceId}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(info, null, 2), { mode: 0o600 });
    renameSync(temporary, serverDescriptorPath());
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function clearServerDescriptor(instanceId: string): void {
  if (readServerDescriptor()?.instanceId === instanceId) {
    rmSync(serverDescriptorPath(), { force: true });
  }
}

export async function verifyServer(descriptor: ServerDescriptor): Promise<boolean> {
  try {
    const info = ServerDescriptorSchema.parse(descriptor);
    const response = await fetch(`${info.endpoint}/api/server`, {
      signal: AbortSignal.timeout(1000),
      redirect: "error",
    });
    if (!response.ok) return false;
    const actual = ServerInfoSchema.parse(await response.json());
    return actual.instanceId === info.instanceId && actual.pid === info.pid &&
      actual.startedAt === info.startedAt;
  } catch {
    return false;
  }
}

export async function discoverServer(): Promise<ServerDescriptor | null> {
  const descriptor = readServerDescriptor();
  return descriptor && await verifyServer(descriptor) ? descriptor : null;
}

export interface ServerLock {
  release(): void;
}

export async function acquireServerLock(): Promise<ServerLock | null> {
  const { DatabaseSync } = await import("node:sqlite");
  mkdirSync(dataDir(), { recursive: true });
  const db = new DatabaseSync(join(dataDir(), "server-lock.sqlite"));
  try {
    db.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
  } catch (cause) {
    db.close();
    if (z.object({ errcode: z.literal(5) }).safeParse(cause).success) return null;
    throw cause;
  }
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      db.close();
    },
  };
}

export function checkServerPort(server: ServerDescriptor, requestedPort?: number): void {
  if (requestedPort !== undefined && Number(new URL(server.endpoint).port || "80") !== requestedPort) {
    throw new Error(`The global server is already running at ${server.endpoint}. Omit --port to attach, or stop that server before using --port ${requestedPort}.`);
  }
}

export async function registerProject(server: ServerDescriptor, path: string): Promise<Project> {
  const response = await fetch(`${server.endpoint}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  });
  if (!response.ok) {
    const payload = z.object({ error: z.string() }).safeParse(await response.json().catch(() => null));
    throw new Error(payload.success ? payload.data.error : `Project registration failed: HTTP ${response.status}`);
  }
  return ProjectSchema.parse(await response.json());
}

export interface LaunchOptions {
  entryPath: string;
  port?: number;
  timeoutMs?: number;
}

export async function ensureServer(options: LaunchOptions): Promise<ServerDescriptor> {
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  const existing = await discoverServer();
  if (existing) {
    checkServerPort(existing, options.port);
    return existing;
  }

  mkdirSync(dataDir(), { recursive: true });
  const logPath = serverLogPath();
  let spawnError: Error | undefined;
  let childRunning = false;
  let launchAfter = 0;
  const args = [...process.execArgv, options.entryPath, "serve", "--port", String(options.port ?? 4777)];
  while (Date.now() < deadline) {
    if (spawnError) throw new Error(`Could not launch diffreview: ${spawnError.message}. Logs: ${logPath}`);
    const server = await discoverServer();
    if (server) {
      checkServerPort(server, options.port);
      return server;
    }
    const now = Date.now();
    if (!childRunning && now >= launchAfter && now < deadline) {
      const log = openSync(logPath, "a", 0o600);
      try {
        const child = spawn(process.execPath, args, {
          cwd: dataDir(),
          detached: true,
          stdio: ["ignore", log, log],
        });
        childRunning = true;
        child.once("error", (error) => { spawnError = error; });
        child.once("exit", () => {
          childRunning = false;
          launchAfter = Date.now() + 500;
        });
        child.unref();
      } finally {
        closeSync(log);
      }
    }
    await sleep(Math.min(100, Math.max(0, deadline - Date.now())));
  }
  let tail = "";
  try {
    tail = readFileSync(logPath, "utf8").slice(-4000).trim();
  } catch {
    tail = "Startup log could not be read.";
  }
  throw new Error(`The global server did not become ready. Stop old per-repository diffreview processes and check for an occupied port. Logs: ${logPath}\n${tail}`);
}

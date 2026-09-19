import { resolve } from "node:path";
import { z } from "zod";
import type { Project, UpdateCommentRequest } from "../shared/types";
import { resolveProjectPath } from "../server/project-path";
import { discoverServer, registerProject } from "../server/server-discovery";

export interface ResolvedClient {
  readonly baseUrl: string;
  readonly repoRoot: string;
  readonly project: Readonly<Project>;
}

export type ResolveResult = { ok: true; client: ResolvedClient } | { ok: false; error: string };

export async function resolveClient(cwd: string = process.cwd()): Promise<ResolveResult> {
  const path = resolve(cwd);
  let repoRoot: string;
  try {
    repoRoot = await resolveProjectPath(path);
  } catch {
    return { ok: false, error: `Not inside an accessible Git working tree (cwd: ${cwd}).` };
  }
  const server = await discoverServer();
  if (!server) {
    return {
      ok: false,
      error: `No verified global diffreview server is available. Ask the user to run: diffreview open ${JSON.stringify(path)} --no-open. Stop old per-repository servers before upgrading.`,
    };
  }
  try {
    const project = await registerProject(server, path);
    if (project.root !== repoRoot) {
      return { ok: false, error: "The server returned a different working tree during project registration. Restart the global diffreview server." };
    }
    return { ok: true, client: Object.freeze({ baseUrl: server.endpoint, repoRoot, project: Object.freeze(project) }) };
  } catch (cause) {
    return {
      ok: false,
      error: `Could not open ${repoRoot} on ${server.endpoint}: ${cause instanceof Error ? cause.message : String(cause)}. Try: diffreview open ${JSON.stringify(path)} --no-open`,
    };
  }
}

type ProjectApiPath = "/meta" | "/diff" | `/comments${string}`;

function projectUrl(client: ResolvedClient, path: ProjectApiPath): string {
  return `${client.baseUrl}/api/projects/${encodeURIComponent(client.project.id)}${path}`;
}

export async function apiGet<T>(client: ResolvedClient, path: ProjectApiPath, schema: z.ZodType<T>): Promise<T> {
  const res = await fetch(projectUrl(client, path), { signal: AbortSignal.timeout(5000), redirect: "error" });
  if (!res.ok) throw new Error(`GET ${path} failed: HTTP ${res.status}`);
  return schema.parse(await res.json());
}

export async function apiPatch<T>(
  client: ResolvedClient,
  path: ProjectApiPath,
  body: UpdateCommentRequest,
  schema: z.ZodType<T>,
): Promise<T | null> {
  const res = await fetch(projectUrl(client, path), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
    redirect: "error",
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`PATCH ${path} failed: HTTP ${res.status}`);
  return schema.parse(await res.json());
}

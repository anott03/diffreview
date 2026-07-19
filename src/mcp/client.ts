import { getRepoRoot } from "../server/git";
import { readSession } from "../server/session";

export interface ResolvedClient {
  baseUrl: string;
  repoRoot: string;
}

export type ResolveResult = { ok: true; client: ResolvedClient } | { ok: false; error: string };

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we can't signal it.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Finds the diffreview server instance for the repo containing `cwd`
 * (opencode spawns MCP servers with the project root as cwd). Validates the
 * session file is fresh: pid alive, port answering, repoRoot matching.
 */
export async function resolveClient(cwd: string = process.cwd()): Promise<ResolveResult> {
  let repoRoot: string;
  try {
    repoRoot = await getRepoRoot(cwd);
  } catch {
    return { ok: false, error: `not inside a git repository (cwd: ${cwd})` };
  }

  const session = readSession(repoRoot);
  if (!session) {
    return {
      ok: false,
      error: `No diffreview instance is running for ${repoRoot}. Ask the user to start one with: diffreview ${repoRoot}`,
    };
  }
  if (!pidAlive(session.pid)) {
    return {
      ok: false,
      error: `Found a stale diffreview session for ${repoRoot} (pid ${session.pid} is dead). Ask the user to restart: diffreview ${repoRoot}`,
    };
  }

  const baseUrl = `http://127.0.0.1:${session.port}`;
  try {
    const res = await fetch(`${baseUrl}/api/meta`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const meta = (await res.json()) as { repoRoot?: string };
    if (meta.repoRoot !== repoRoot) {
      return {
        ok: false,
        error: `Stale diffreview session file (repo mismatch). Ask the user to restart: diffreview ${repoRoot}`,
      };
    }
  } catch {
    return {
      ok: false,
      error: `diffreview is not responding on port ${session.port}. Ask the user to restart: diffreview ${repoRoot}`,
    };
  }

  return { ok: true, client: { baseUrl, repoRoot } };
}

export async function apiGet<T>(client: ResolvedClient, path: string): Promise<T> {
  const res = await fetch(`${client.baseUrl}${path}`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`GET ${path} failed: HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Returns null on 404, throws on other failures. */
export async function apiPatch<T>(client: ResolvedClient, path: string, body: unknown): Promise<T | null> {
  const res = await fetch(`${client.baseUrl}${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`PATCH ${path} failed: HTTP ${res.status}`);
  return (await res.json()) as T;
}

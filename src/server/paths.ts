import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

/** Root of diffreview's global data store. */
export function dataDir(): string {
  const base = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(base, "diff-review");
}

/** Stable per-repo key derived from the canonical repo root path. */
export function repoHash(repoRoot: string): string {
  return createHash("sha1").update(repoRoot).digest("hex");
}

export function dbPathForRepo(repoRoot: string): string {
  return join(dataDir(), `${repoHash(repoRoot)}.sqlite`);
}

export function sessionsDir(): string {
  return join(dataDir(), "sessions");
}

export function sessionPathForRepo(repoRoot: string): string {
  return join(sessionsDir(), `${repoHash(repoRoot)}.json`);
}

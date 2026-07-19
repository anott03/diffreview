import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { SessionInfo } from "../shared/types";
import { sessionPathForRepo, sessionsDir } from "./paths";

/**
 * The session file is how diffreview-mcp (spawned by opencode with the repo
 * as cwd) discovers the running server for that repo. Stale files (crash)
 * are tolerated: readers must verify pid/port before use.
 */
export function writeSession(info: SessionInfo): void {
  mkdirSync(sessionsDir(), { recursive: true });
  writeFileSync(sessionPathForRepo(info.repoRoot), JSON.stringify(info, null, 2));
}

export function readSession(repoRoot: string): SessionInfo | null {
  try {
    return JSON.parse(readFileSync(sessionPathForRepo(repoRoot), "utf8")) as SessionInfo;
  } catch {
    return null;
  }
}

export function clearSession(repoRoot: string): void {
  try {
    rmSync(sessionPathForRepo(repoRoot));
  } catch {
    // Already gone.
  }
}

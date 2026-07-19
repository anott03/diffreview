import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { DiffFile, Meta } from "../shared/types";
import { buildUntrackedBinaryFile, buildUntrackedFile, parseGitDiff } from "./diff";

const execFileAsync = promisify(execFile);

const GIT_BUFFER_BYTES = 64 * 1024 * 1024;
const MAX_UNTRACKED_BYTES = 1024 * 1024; // 1MB — larger untracked files shown as "binary"
const BINARY_SNIFF_BYTES = 8000; // git's own heuristic window

export async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: root,
    maxBuffer: GIT_BUFFER_BYTES,
  });
  return stdout;
}

export async function getRepoRoot(cwd: string): Promise<string> {
  try {
    const top = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
    // Canonicalize (resolves symlinks) so the store/session hash is stable.
    return await realpath(top);
  } catch {
    throw new Error(`not a git repository: ${cwd}`);
  }
}

export async function hasHead(root: string): Promise<boolean> {
  try {
    await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

async function getBranch(root: string): Promise<string> {
  try {
    return (await git(root, ["symbolic-ref", "--short", "--quiet", "HEAD"])).trim();
  } catch {
    return "detached";
  }
}

async function getHeadSha(root: string): Promise<string> {
  if (!(await hasHead(root))) return "";
  return (await git(root, ["rev-parse", "HEAD"])).trim();
}

export async function getMeta(root: string, files: DiffFile[]): Promise<Meta> {
  const [branch, head] = await Promise.all([getBranch(root), getHeadSha(root)]);
  return {
    repoRoot: root,
    branch,
    head,
    files: files.length,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
  };
}

// ---------------------------------------------------------------------------
// Diff collection
// ---------------------------------------------------------------------------

async function trackedDiffText(root: string): Promise<string> {
  const args = ["--no-color", "--find-renames", "--no-ext-diff"];
  // Uncommitted vs HEAD covers staged + unstaged. In a repo with no commits
  // yet, everything staged is "new" — diff the index against the empty tree.
  return (await hasHead(root))
    ? git(root, ["diff", "HEAD", ...args])
    : git(root, ["diff", "--cached", ...args]);
}

async function listUntracked(root: string): Promise<string[]> {
  const out = await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  return out.split("\0").filter(Boolean);
}

function isBinaryBuffer(buf: Buffer): boolean {
  const len = Math.min(buf.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

async function readUntrackedFiles(root: string, paths: string[]): Promise<DiffFile[]> {
  const files: DiffFile[] = [];
  for (const path of paths) {
    try {
      const abs = join(root, path);
      const st = await stat(abs);
      if (!st.isFile()) continue;
      if (st.size > MAX_UNTRACKED_BYTES) {
        files.push(buildUntrackedBinaryFile(path));
        continue;
      }
      const buf = await readFile(abs);
      files.push(
        isBinaryBuffer(buf)
          ? buildUntrackedBinaryFile(path)
          : buildUntrackedFile(path, buf.toString("utf8")),
      );
    } catch {
      // Vanished between listing and reading — skip.
    }
  }
  return files;
}

/** One-shot structured diff: tracked changes vs HEAD plus untracked files. */
export async function getDiffFiles(root: string): Promise<DiffFile[]> {
  const [text, untrackedPaths] = await Promise.all([trackedDiffText(root), listUntracked(root)]);
  const untracked = await readUntrackedFiles(root, untrackedPaths);
  return [...parseGitDiff(text), ...untracked];
}

// ---------------------------------------------------------------------------
// Poll-based watcher
// ---------------------------------------------------------------------------

interface RawState {
  hash: string;
  diffText: string;
  untrackedPaths: string[];
}

/**
 * Everything that can change the rendered diff, hashed cheaply:
 * HEAD position, index/working-tree status, the diff text itself, and
 * untracked file stats (mtime+size — untracked content isn't in the diff).
 */
async function collectState(root: string): Promise<RawState> {
  const [headSha, status, diffText, untrackedPaths] = await Promise.all([
    getHeadSha(root),
    git(root, ["status", "--porcelain=v1"]),
    trackedDiffText(root),
    listUntracked(root),
  ]);

  const parts = [headSha || "nohead", status, diffText];
  for (const path of untrackedPaths) {
    try {
      const st = await stat(join(root, path));
      parts.push(`${path}:${st.mtimeMs}:${st.size}`);
    } catch {
      // Vanished — the listing above is already stale; next cycle will settle.
    }
  }

  return {
    hash: createHash("sha1").update(parts.join("\0")).digest("hex"),
    diffText,
    untrackedPaths,
  };
}

export class DiffWatcher {
  /** Latest parsed diff. Empty until the first successful refresh. */
  files: DiffFile[] = [];
  /** Called after `files` changes (set by the HTTP layer for SSE fan-out). */
  onChange?: (files: DiffFile[]) => void;

  private lastHash = "";
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private root: string,
    private intervalMs: number,
  ) {}

  /** Re-collect state; re-parses and notifies only when the hash changed. */
  async refresh(): Promise<void> {
    const state = await collectState(this.root);
    if (state.hash === this.lastHash) return;
    this.lastHash = state.hash;
    const untracked = await readUntrackedFiles(this.root, state.untrackedPaths);
    this.files = [...parseGitDiff(state.diffText), ...untracked];
    this.onChange?.(this.files);
  }

  /** Starts polling. The first tick runs immediately (async). */
  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return; // never overlap slow git runs
    this.running = true;
    try {
      await this.refresh();
    } catch {
      // Transient git failure (e.g. index.lock mid-rebase) — retry next cycle.
    } finally {
      this.running = false;
    }
  }
}

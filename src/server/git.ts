/**
 * Git access as an Effect service.
 *
 * `Git` is the domain service (typed errors, composable). The free functions
 * below it (`git`, `getRepoRoot`, `hasHead`, `getMeta`, `getDiffFiles`) are an
 * interim bridge over a module-level ManagedRuntime so the existing Hono
 * routes, DiffWatcher, and tests keep working until the HTTP layer is
 * migrated (migration steps 5-10 of .thoughts/effect-migration.md).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Context, Effect, Layer, ManagedRuntime, Schema } from "effect";
import type { DiffFile, Meta } from "../shared/types";
import { buildUntrackedBinaryFile, buildUntrackedFile, parseGitDiff } from "./diff";

const execFileAsync = promisify(execFile);

const GIT_BUFFER_BYTES = 64 * 1024 * 1024;
const MAX_UNTRACKED_BYTES = 1024 * 1024; // 1MB — larger untracked files shown as "binary"
const BINARY_SNIFF_BYTES = 8000; // git's own heuristic window

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class GitError extends Schema.TaggedError<GitError>()("GitError", {
  args: Schema.Array(Schema.String),
  cause: Schema.Defect()
}) {}

export class NotARepoError extends Schema.TaggedError<NotARepoError>()("NotARepoError", {
  cwd: Schema.String
}) {}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

interface RawState {
  hash: string;
  diffText: string;
  untrackedPaths: string[];
}

export class Git extends Context.Service<Git, {
  /** Run a git command in `root`, returning stdout. */
  run(root: string, args: string[]): Effect.Effect<string, GitError>;
  /** Canonical repo root (symlinks resolved), or NotARepoError. */
  getRepoRoot(cwd: string): Effect.Effect<string, NotARepoError>;
  hasHead(root: string): Effect.Effect<boolean>;
  getMeta(root: string, files: ReadonlyArray<DiffFile>): Effect.Effect<Meta, GitError>;
  trackedDiffText(root: string): Effect.Effect<string, GitError>;
  listUntracked(root: string): Effect.Effect<Array<string>, GitError>;
  readUntrackedFiles(
    root: string,
    paths: ReadonlyArray<string>
  ): Effect.Effect<Array<DiffFile>>;
  collectState(root: string): Effect.Effect<RawState, GitError>;
  getDiffFiles(root: string): Effect.Effect<Array<DiffFile>, GitError>;
}>()("diffreview/server/Git") {
  static readonly layer = Layer.effect(
    Git,
    Effect.gen(function*() {
      const run = Effect.fn("Git.run")(function*(root: string, args: string[]) {
        return yield* Effect.tryPromise({
          try: () =>
            execFileAsync("git", args, { cwd: root, maxBuffer: GIT_BUFFER_BYTES }).then(
              (r) => r.stdout
            ),
          catch: (cause) => new GitError({ args, cause })
        });
      });

      const hasHead = Effect.fn("Git.hasHead")(function*(root: string) {
        return yield* run(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).pipe(
          Effect.as(true),
          Effect.catch(() => Effect.succeed(false))
        );
      });

      const getRepoRoot = Effect.fn("Git.getRepoRoot")(function*(cwd: string) {
        const top = yield* run(cwd, ["rev-parse", "--show-toplevel"]).pipe(
          Effect.catch(() => new NotARepoError({ cwd }))
        );
        // Canonicalize (resolves symlinks) so the store/session hash is stable.
        return yield* Effect.tryPromise({
          try: () => realpath(top.trim()),
          catch: () => new NotARepoError({ cwd })
        });
      });

      const getBranch = Effect.fn("Git.getBranch")(function*(root: string) {
        const branch = yield* run(root, ["symbolic-ref", "--short", "--quiet", "HEAD"]).pipe(
          Effect.catch(() => Effect.succeed("detached"))
        );
        return branch.trim();
      });

      const getHeadSha = Effect.fn("Git.getHeadSha")(function*(root: string) {
        if (!(yield* hasHead(root))) return "";
        const sha = yield* run(root, ["rev-parse", "HEAD"]);
        return sha.trim();
      });

      const getMeta = Effect.fn("Git.getMeta")(function*(
        root: string,
        files: ReadonlyArray<DiffFile>
      ) {
        const [branch, head] = yield* Effect.all(
          [getBranch(root), getHeadSha(root)],
          { concurrency: "unbounded" }
        );
        return {
          repoRoot: root,
          branch,
          head,
          files: files.length,
          additions: files.reduce((n, f) => n + f.additions, 0),
          deletions: files.reduce((n, f) => n + f.deletions, 0)
        };
      });

      // -- Diff collection -----------------------------------------------------

      const trackedDiffText = Effect.fn("Git.trackedDiffText")(function*(root: string) {
        const args = ["--no-color", "--find-renames", "--no-ext-diff"];
        // Uncommitted vs HEAD covers staged + unstaged. In a repo with no
        // commits yet, everything staged is "new" — diff the index against
        // the empty tree.
        return (yield* hasHead(root))
          ? yield* run(root, ["diff", "HEAD", ...args])
          : yield* run(root, ["diff", "--cached", ...args]);
      });

      const listUntracked = Effect.fn("Git.listUntracked")(function*(root: string) {
        const out = yield* run(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
        return out.split("\0").filter(Boolean);
      });

      function isBinaryBuffer(buf: Buffer): boolean {
        const len = Math.min(buf.length, BINARY_SNIFF_BYTES);
        for (let i = 0; i < len; i++) {
          if (buf[i] === 0) return true;
        }
        return false;
      }

      const readUntrackedFile = (
        root: string,
        path: string
      ): Effect.Effect<DiffFile | null> =>
        Effect.gen(function*() {
          const abs = join(root, path);
          // A `null` failure means "vanished between listing and reading" —
          // the caller skips it.
          const st = yield* Effect.tryPromise({
            try: () => stat(abs),
            // A failed stat means "vanished between listing and reading" —
            // surfaced as a null result for the caller to skip.
            catch: (cause) => cause
          }).pipe(Effect.catch(() => Effect.succeed(null)));
          if (st === null || !st.isFile()) return null;
          if (st.size > MAX_UNTRACKED_BYTES) return buildUntrackedBinaryFile(path);
          const buf = yield* Effect.tryPromise({
            try: () => readFile(abs),
            catch: (cause) => cause
          }).pipe(Effect.catch(() => Effect.succeed(null)));
          if (buf === null) return null;
          return isBinaryBuffer(buf)
            ? buildUntrackedBinaryFile(path)
            : buildUntrackedFile(path, buf.toString("utf8"));
        });

      const readUntrackedFiles = Effect.fn("Git.readUntrackedFiles")(function*(
        root: string,
        paths: ReadonlyArray<string>
      ) {
        const files: DiffFile[] = [];
        for (const path of paths) {
          const file = yield* readUntrackedFile(root, path);
          if (file !== null) files.push(file);
        }
        return files;
      });

      /** One-shot structured diff: tracked changes vs HEAD plus untracked files. */
      const getDiffFiles = Effect.fn("Git.getDiffFiles")(function*(root: string) {
        const [text, untrackedPaths] = yield* Effect.all(
          [trackedDiffText(root), listUntracked(root)],
          { concurrency: "unbounded" }
        );
        const untracked = yield* readUntrackedFiles(root, untrackedPaths);
        return [...parseGitDiff(text), ...untracked];
      });

      // -- Poll state ----------------------------------------------------------

      /**
       * Everything that can change the rendered diff, hashed cheaply:
       * HEAD position, index/working-tree status, the diff text itself, and
       * untracked file stats (mtime+size — untracked content isn't in the diff).
       */
      const collectState = Effect.fn("Git.collectState")(function*(root: string) {
        const [headSha, status, diffText, untrackedPaths] = yield* Effect.all(
          [
            getHeadSha(root),
            run(root, ["status", "--porcelain=v1"]),
            trackedDiffText(root),
            listUntracked(root)
          ],
          { concurrency: "unbounded" }
        );

        const parts = [headSha || "nohead", status, diffText];
        for (const path of untrackedPaths) {
          const st = yield* Effect.tryPromise({
            try: () => stat(join(root, path)),
            catch: (cause) => cause
          }).pipe(Effect.catch(() => Effect.succeed(null)));
          // Vanished — the listing above is already stale; next cycle settles.
          if (st !== null) parts.push(`${path}:${st.mtimeMs}:${st.size}`);
        }

        return {
          hash: createHash("sha1").update(parts.join("\0")).digest("hex"),
          diffText,
          untrackedPaths
        };
      });

      return Git.of({
        run,
        getRepoRoot,
        hasHead,
        getMeta,
        trackedDiffText,
        listUntracked,
        readUntrackedFiles,
        collectState,
        getDiffFiles
      });
    })
  );
}

// ---------------------------------------------------------------------------
// Interim bridge (removed when Hono/DiffWatcher migrate to Effect)
// ---------------------------------------------------------------------------

const runtime = ManagedRuntime.make(Git.layer);

export async function git(root: string, args: string[]): Promise<string> {
  return runtime.runPromise(Git.use((g) => g.run(root, args)));
}

export async function getRepoRoot(cwd: string): Promise<string> {
  return runtime.runPromise(
    Git.use((g) => g.getRepoRoot(cwd)).pipe(
      // Preserve the pre-Effect error message consumed by cli.ts.
      Effect.mapError((e) => new Error(`not a git repository: ${e.cwd}`))
    )
  );
}

export async function hasHead(root: string): Promise<boolean> {
  return runtime.runPromise(Git.use((g) => g.hasHead(root)));
}

export async function getMeta(root: string, files: DiffFile[]): Promise<Meta> {
  return runtime.runPromise(Git.use((g) => g.getMeta(root, files)));
}

export async function getDiffFiles(root: string): Promise<DiffFile[]> {
  return runtime.runPromise(Git.use((g) => g.getDiffFiles(root)));
}

const collectStateBridge = (root: string) =>
  runtime.runPromise(Git.use((g) => g.collectState(root)));

const readUntrackedFilesBridge = (root: string, paths: ReadonlyArray<string>) =>
  runtime.runPromise(Git.use((g) => g.readUntrackedFiles(root, paths)));

// ---------------------------------------------------------------------------
// Poll-based watcher (migrated to an Effect service in step 5)
// ---------------------------------------------------------------------------

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
    const state = await collectStateBridge(this.root);
    if (state.hash === this.lastHash) return;
    this.lastHash = state.hash;
    const untracked = await readUntrackedFilesBridge(this.root, state.untrackedPaths);
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

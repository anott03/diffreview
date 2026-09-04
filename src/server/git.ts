/**
 * Git access as an Effect service (typed errors, Layer-composable).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
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
            try: () => lstat(abs),
            // A failed stat means "vanished between listing and reading" —
            // surfaced as a null result for the caller to skip.
            catch: (cause) => cause
          }).pipe(Effect.catch(() => Effect.succeed(null)));
          if (st === null) return null;
          // Untracked symlinks are shown git-faithfully: the blob content is
          // the link target path — never the target's contents (which could
          // point outside the repository).
          if (st.isSymbolicLink()) {
            const target = yield* Effect.tryPromise({
              try: () => readlink(abs, "utf8"),
              catch: (cause) => cause
            }).pipe(Effect.catch(() => Effect.succeed(null)));
            if (target === null) return null;
            return buildUntrackedFile(path, target);
          }
          if (!st.isFile()) return null;
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
            try: () => lstat(join(root, path)),
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
// Standalone repo-root resolution
// ---------------------------------------------------------------------------

/**
 * Resolves the canonical git repo root for `cwd` — shared by the cli (before
 * the server layer exists) and diffreview-mcp's discovery flow, both of which
 * run outside the server's Effect runtime. Throws
 * `Error("not a git repository: <cwd>")` on failure (message consumed by the
 * cli's fail()).
 */
export async function getRepoRoot(cwd: string): Promise<string> {
  let top: string;
  try {
    top = (
      await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
        cwd,
        maxBuffer: GIT_BUFFER_BYTES,
      })
    ).stdout.trim();
  } catch {
    throw new Error(`not a git repository: ${cwd}`);
  }
  // Canonicalize (resolves symlinks) so the store/session hash is stable.
  try {
    return await realpath(top);
  } catch {
    throw new Error(`not a git repository: ${cwd}`);
  }
}

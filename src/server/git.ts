/**
 * Git access as an Effect service (typed errors, Layer-composable).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
import type { CommitSummary, DiffFile, Meta } from "../shared/types";
import { buildUntrackedBinaryFile, buildUntrackedFile, parseGitDiff } from "./diff";
import { readWorkingTreeFile } from "./worktree-files";

const execFileAsync = promisify(execFile);

const GIT_BUFFER_BYTES = 64 * 1024 * 1024;

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
  head: string;
  diffText: string;
  untrackedPaths: string[];
}

/**
 * Machine-readable `git log` format. NUL separates fields within a record and
 * STX (`%x02`) separates records, so a newline embedded in an ident does not
 * misalign subsequent records. None of the chosen fields may contain NUL.
 */
const COMMIT_LOG_FORMAT = "%H%x00%s%x00%an%x00%ae%x00%at%x00%P%x00%x02";

function parseCommitLog(out: string): CommitSummary[] {
  return out.split("\x02").flatMap((record) => {
    const [id, subject, author, authorEmail, date, parents] = record.trim().split("\0");
    if (!id) return [];
    return [{
      id,
      subject: subject ?? "",
      author: author ?? "",
      authorEmail: authorEmail ?? "",
      date: Number(date ?? "0") * 1000,
      parents: (parents ?? "").split(" ").filter(Boolean)
    }];
  });
}

export class Git extends Context.Service<Git, {
  /** Run a git command in `root`, returning stdout. */
  run(root: string, args: string[]): Effect.Effect<string, GitError>;
  /** Canonical repo root (symlinks resolved), or NotARepoError. */
  getRepoRoot(cwd: string): Effect.Effect<string, NotARepoError>;
  hasHead(root: string): Effect.Effect<boolean>;
  hasCommit(root: string, commitId: string): Effect.Effect<boolean>;
  getMeta(root: string, files: ReadonlyArray<DiffFile>): Effect.Effect<Meta, GitError>;
  listCommits(root: string, options: { limit: number; offset: number }): Effect.Effect<Array<CommitSummary>, GitError>;
  getCommitDiff(root: string, commitId: string): Effect.Effect<Array<DiffFile>, GitError>;
  trackedDiffText(root: string): Effect.Effect<string, GitError>;
  listUntracked(root: string): Effect.Effect<Array<string>, GitError>;
  readUntrackedFiles(
    root: string,
    paths: ReadonlyArray<string>
  ): Effect.Effect<Array<DiffFile>>;
  collectState(root: string): Effect.Effect<RawState, GitError>;
  getDiffFiles(root: string): Effect.Effect<Array<DiffFile>, GitError>;
}>()("diffreview/server/Git") {
  static readonly layer = Layer.sync(
    Git,
    () => {
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

      const hasCommit = Effect.fn("Git.hasCommit")(function*(root: string, commitId: string) {
        return yield* run(root, ["rev-parse", "--verify", "--quiet", `${commitId}^{commit}`]).pipe(
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

      const readUntrackedFile = (
        root: string,
        path: string
      ): Effect.Effect<DiffFile | null> =>
        Effect.gen(function*() {
          const file = yield* Effect.try(() => readWorkingTreeFile(root, path, "git")).pipe(
            Effect.catch(() => Effect.succeed(null))
          );
          if (file === null || file.kind === "unsupported") return null;
          if (file.kind === "binary" || file.kind === "too-large") return buildUntrackedBinaryFile(path);
          return file.content === null ? null : buildUntrackedFile(path, file.content);
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

      // -- Commit history ------------------------------------------------------

      const listCommits = Effect.fn("Git.listCommits")(function*(
        root: string,
        options: { limit: number; offset: number }
      ) {
        // Offset pagination assumes HEAD stays put between page loads. If the
        // branch moves, a page can skip or repeat commits. This is acceptable
        // for a local review tool, but a cursor-based scheme would be needed
        // to page a branch that is mutating concurrently.
        const out = yield* run(root, [
          "log", "HEAD", `--format=${COMMIT_LOG_FORMAT}`,
          "-n", String(options.limit), "--skip", String(options.offset)
        ]);
        return parseCommitLog(out);
      });

      const getCommitDiff = Effect.fn("Git.getCommitDiff")(function*(root: string, commitId: string) {
        // `-m --first-parent` makes merge commits diff against their first
        // parent instead of producing a combined (`@@@`) diff, which parse-diff
        // cannot parse. Non-merge commits are unaffected.
        const text = yield* run(root, [
          "show", "--no-color", "--find-renames", "--no-ext-diff", "--format=",
          "--first-parent", "-m", commitId
        ]);
        return parseGitDiff(text);
      });

      // -- Poll state ----------------------------------------------------------

      /**
       * Everything that can change the rendered diff, hashed cheaply:
       * HEAD position, index/working-tree status, the diff text itself, and
       * untracked file stats (mtime+size — untracked content isn't in the diff).
       */
      const collectState = Effect.fn("Git.collectState")(function*(root: string) {
        const headSha = yield* getHeadSha(root);
        const [status, diffText, untrackedPaths] = yield* Effect.all(
          [
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
          head: headSha,
          hash: createHash("sha1").update(parts.join("\0")).digest("hex"),
          diffText,
          untrackedPaths
        };
      });

      return Git.of({
        run,
        getRepoRoot,
        hasHead,
        hasCommit,
        getMeta,
        trackedDiffText,
        listUntracked,
        readUntrackedFiles,
        collectState,
        getDiffFiles,
        listCommits,
        getCommitDiff
      });
    }
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

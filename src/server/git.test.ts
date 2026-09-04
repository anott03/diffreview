import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { diffFilePath } from "../shared/types";
import { Git, NotARepoError } from "./git";

const execFileAsync = promisify(execFile);
const git = (cwd: string, args: string[]) => execFileAsync("git", args, { cwd });

const dirs: string[] = [];

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "diffreview-git-"));
  dirs.push(dir);
  await git(dir, ["init", "--quiet"]);
  await writeFile(join(dir, "a.txt"), "one\ntwo\nthree\n");
  await git(dir, ["add", "."]);
  await git(dir, ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "--quiet", "-m", "init"]);
  return dir;
}

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** Runs an effect requiring the Git service against the real Git layer. */
const run = <A, E>(effect: Effect.Effect<A, E, Git>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Git.layer)));

describe("Git.getDiffFiles", () => {
  it("collects modified, staged, and untracked files", async () => {
    const dir = await makeRepo();
    // Unstaged modification
    await writeFile(join(dir, "a.txt"), "one\nTWO\nthree\n");
    // Staged new file
    await writeFile(join(dir, "staged.txt"), "staged\n");
    await git(dir, ["add", "staged.txt"]);
    // Untracked file
    await writeFile(join(dir, "untracked.txt"), "hello\nworld\n");

    const files = await run(Git.use((g) => g.getDiffFiles(dir)));
    const byPath = new Map(files.map((f) => [diffFilePath(f), f]));

    const modified = byPath.get("a.txt");
    expect(modified?.status).toBe("modified");
    expect(modified?.additions).toBe(1);
    expect(modified?.deletions).toBe(1);

    const staged = byPath.get("staged.txt");
    expect(staged?.status).toBe("added");
    expect(staged?.additions).toBe(1);

    const untracked = byPath.get("untracked.txt");
    expect(untracked?.status).toBe("added");
    expect(untracked?.additions).toBe(2);
    expect(untracked?.hunks[0]?.lines[1]).toEqual({ type: "add", newLine: 2, content: "world" });
  });

  it("handles a repo with no commits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "diffreview-git-"));
    dirs.push(dir);
    await git(dir, ["init", "--quiet"]);
    expect(await run(Git.use((g) => g.hasHead(dir)))).toBe(false);

    await writeFile(join(dir, "first.txt"), "alpha\n");
    await git(dir, ["add", "first.txt"]);
    await writeFile(join(dir, "unstaged.txt"), "beta\n");

    const files = await run(Git.use((g) => g.getDiffFiles(dir)));
    const byPath = new Map(files.map((f) => [diffFilePath(f), f]));
    expect(byPath.get("first.txt")?.status).toBe("added");
    expect(byPath.get("first.txt")?.additions).toBe(1);
    expect(byPath.get("unstaged.txt")?.status).toBe("added");
  });

  it("marks untracked binary files", async () => {
    const dir = await makeRepo();
    const bin = Buffer.from([0x89, 0x50, 0x00, 0x0d, 0x1a, 0x0a]);
    await writeFile(join(dir, "blob.bin"), bin);

    const files = await run(Git.use((g) => g.getDiffFiles(dir)));
    const blob = files.find((f) => f.newPath === "blob.bin");
    expect(blob?.isBinary).toBe(true);
    expect(blob?.hunks).toHaveLength(0);
  });

  it("returns an empty array for a clean repo", async () => {
    const dir = await makeRepo();
    expect(await run(Git.use((g) => g.getDiffFiles(dir)))).toEqual([]);
  });
});

describe("Git.getRepoRoot", () => {
  it("returns the canonical root for a repo", async () => {
    const dir = await makeRepo();
    expect(await run(Git.use((g) => g.getRepoRoot(dir)))).toBe(dir);
  });

  it("fails with NotARepoError for a non-repo directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "diffreview-norepo-"));
    dirs.push(dir);
    const error = await run(
      Effect.flip(Git.use((g) => g.getRepoRoot(dir)))
    );
    expect(error).toBeInstanceOf(NotARepoError);
    expect(error.cwd).toBe(dir);
  });
});

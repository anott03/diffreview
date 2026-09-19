import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isWorkingTreePath, listWorkingTreeFiles, readWorkingTreeFile } from "./worktree-files";

const exec = promisify(execFile);
let directory: string;
let root: string;
const git = (args: string[]) => exec("git", args, { cwd: root });
const list = async () => listWorkingTreeFiles(root, (await git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])).stdout);

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "diffreview-files-"));
  root = join(directory, "repo");
  await mkdir(root);
  await git(["init", "--quiet"]);
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("working tree files", () => {
  it("lists tracked and nonignored untracked paths, without duplicates, deleted files, or Git internals", async () => {
    await writeFile(join(root, ".gitignore"), "ignored.txt\n");
    await writeFile(join(root, "tracked.txt"), "tracked\n");
    await writeFile(join(root, "deleted.txt"), "deleted\n");
    await writeFile(join(root, "staged-deletion.txt"), "deleted\n");
    await git(["add", "."]);
    await git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial", "--quiet"]);
    await rm(join(root, "deleted.txt"));
    await git(["rm", "staged-deletion.txt"]);
    await writeFile(join(root, "ignored.txt"), "secret\n");
    await writeFile(join(root, "with space\nand newline.txt"), "untracked\n");
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", "new.txt"), "new\n");
    expect(await list()).toEqual([".gitignore", "nested/new.txt", "tracked.txt", "with space\nand newline.txt"]);
    expect(listWorkingTreeFiles(root, "tracked.txt\0tracked.txt\0.git/config\0nested\0missing\0")).toEqual(["tracked.txt"]);
  });

  it("reads current text, empty files, and exactly 1 MiB without altering contents", async () => {
    for (const [path, content] of [["text.txt", "héllo\n\n"], ["empty.txt", ""], ["limit.txt", "x".repeat(1024 * 1024)]]) {
      await writeFile(join(root, path!), content!);
      expect(readWorkingTreeFile(root, path!)).toEqual({ path, kind: "text", content });
    }
    await writeFile(join(root, "text.txt"), "changed\n");
    expect(readWorkingTreeFile(root, "text.txt").content).toBe("changed\n");
  });

  it("returns placeholders for binary, invalid UTF-8, and oversized files", async () => {
    await writeFile(join(root, "binary"), Buffer.from([65, 0, 66]));
    await writeFile(join(root, "invalid"), Buffer.from([0xff, 0xfe]));
    await writeFile(join(root, "large"), Buffer.alloc(1024 * 1024 + 1, 65));
    expect(readWorkingTreeFile(root, "binary")).toEqual({ path: "binary", kind: "binary", content: null });
    expect(readWorkingTreeFile(root, "invalid")).toEqual({ path: "invalid", kind: "binary", content: null });
    expect(readWorkingTreeFile(root, "large")).toEqual({ path: "large", kind: "too-large", content: null });
  });

  it("reads symlink text, including links outside the repo and dangling links, without following them", async () => {
    const outside = join(directory, "secret");
    await writeFile(outside, "must not read");
    await symlink(outside, join(root, "external"));
    await symlink("missing", join(root, "dangling"));
    await symlink(".git/config", join(root, "git-link"));
    expect(await list()).toEqual(["dangling", "external", "git-link"]);
    for (const [path, content] of [["external", outside], ["dangling", "missing"], ["git-link", ".git/config"]]) {
      expect(readWorkingTreeFile(root, path!)).toEqual({ path, kind: "symlink", content });
    }
  });

  it("rejects traversal and absolute paths and excludes tracked paths under replaced symlink parents", async () => {
    await mkdir(join(root, "dir"));
    await writeFile(join(root, "dir", "secret"), "tracked\n");
    await git(["add", "."]);
    await rm(join(root, "dir"), { recursive: true });
    await writeFile(join(directory, "secret"), "outside\n");
    await symlink(directory, join(root, "dir"));
    expect(await list()).not.toContain("dir/secret");
    expect(() => readWorkingTreeFile(root, "dir/secret")).toThrow();
    for (const path of ["", "../secret", "dir/../../secret", "/etc/passwd", "C:/secret", "C:\\secret", "dir\\secret", "./secret", "dir//secret", "secret\0", ".git/config", "dir/.git/config"]) {
      expect(isWorkingTreePath(path)).toBe(false);
      expect(() => readWorkingTreeFile(root, path)).toThrow();
    }
  });

  it("does not open tracked special files", async () => {
    await writeFile(join(root, "pipe"), "tracked");
    await git(["add", "."]);
    await rm(join(root, "pipe"));
    await exec("mkfifo", [join(root, "pipe")]);
    expect(await list()).toEqual(["pipe"]);
    expect(readWorkingTreeFile(root, "pipe")).toEqual({ path: "pipe", kind: "unsupported", content: null });
  });
});

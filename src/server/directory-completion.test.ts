import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listDirectories } from "./directory-completion";

let root: string;
let parent: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "diffreview-directories-"));
  parent = join(root, "parent");
  await mkdir(parent);
  for (const name of ["alpha", "alpine", "Beta", ".hidden", "dir #?&é"]) {
    await mkdir(join(parent, name));
  }
  await writeFile(join(parent, "notes.txt"), "not a directory");
});

afterEach(() => rm(root, { recursive: true, force: true }));

describe("directory completion", () => {
  it("lists all immediate directories after a separator in deterministic order", async () => {
    await mkdir(join(parent, "alpha", "nested"));
    expect(await listDirectories(`${parent}${sep}`)).toEqual({
      directories: [".hidden", "Beta", "alpha", "alpine", "dir #?&é"].map((name) => `${join(parent, name)}${sep}`)
    });
  });

  it("matches partial names case-insensitively and preserves their actual spelling", async () => {
    expect(await listDirectories(join(parent, "AL"))).toEqual({
      directories: [`${join(parent, "alpha")}${sep}`, `${join(parent, "alpine")}${sep}`]
    });
    expect(await listDirectories(join(parent, "be"))).toEqual({
      directories: [`${join(parent, "Beta")}${sep}`]
    });
  });

  it("lists children after choosing a completed directory", async () => {
    await mkdir(join(parent, "alpha", "nested"));
    const { directories } = await listDirectories(join(parent, "alph"));
    expect(await listDirectories(directories[0]!)).toEqual({
      directories: [`${join(parent, "alpha", "nested")}${sep}`]
    });
  });

  it("returns absolute suggestions for relative paths", async () => {
    expect(await listDirectories(relative(process.cwd(), join(parent, "alph")))).toEqual({
      directories: [`${join(parent, "alpha")}${sep}`]
    });
  });

  it("preserves spaces and special characters in directory paths", async () => {
    expect(await listDirectories(join(parent, "dir #?"))).toEqual({
      directories: [`${join(parent, "dir #?&é")}${sep}`]
    });
  });

  it("follows directory symlinks but excludes file and broken symlinks", async () => {
    const outside = join(root, "outside");
    await mkdir(join(outside, "nested"), { recursive: true });
    await symlink(outside, join(parent, "link-directory"), "dir");
    await symlink(join(parent, "notes.txt"), join(parent, "link-file"), "file");
    await symlink(join(root, "missing"), join(parent, "link-broken"), "dir");
    expect(await listDirectories(join(parent, "link-"))).toEqual({
      directories: [`${join(parent, "link-directory")}${sep}`]
    });
    expect(await listDirectories(`${join(parent, "link-directory")}${sep}`)).toEqual({
      directories: [`${join(parent, "link-directory", "nested")}${sep}`]
    });
  });

  it("returns no suggestions for missing parents, files, or unmatched prefixes", async () => {
    for (const path of [
      `${join(parent, "missing")}${sep}`,
      join(parent, "missing", "child"),
      `${join(parent, "notes.txt")}${sep}`,
      join(parent, "notes.txt", "child"),
      join(parent, "unmatched")
    ]) {
      expect(await listDirectories(path)).toEqual({ directories: [] });
    }
  });

  it("does not enumerate the server working directory for an empty path", async () => {
    expect(await listDirectories("")).toEqual({ directories: [] });
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("propagates permission-denied errors", async () => {
    const locked = join(parent, "locked");
    await mkdir(locked);
    await chmod(locked, 0);
    try {
      await expect(listDirectories(`${locked}${sep}`)).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      await chmod(locked, 0o700);
    }
  });
});

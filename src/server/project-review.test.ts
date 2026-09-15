import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import type { CommentSide, CreateCommentRequest } from "../shared/types";
import { ProjectConfig } from "./config";
import { Git } from "./git";
import { ProjectReview } from "./project-review";
import { CommentStore } from "./store";
import { Watcher } from "./watcher";

const exec = promisify(execFile);
const git = (root: string, args: string[]) => exec("git", args, { cwd: root });
const directories: string[] = [];
const disposals: (() => Promise<void>)[] = [];
const lines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);
const text = `${lines.join("\n")}\n`;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "diffreview-anchors-"));
  directories.push(directory);
  const root = join(directory, "repo");
  await mkdir(root);
  await git(root, ["init", "--quiet"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await writeFile(join(root, "file.txt"), text);
  await git(root, ["add", "."]);
  await git(root, ["commit", "--quiet", "-m", "initial"]);
  const commands: string[][] = [];
  const counted = Layer.effect(Git, Effect.gen(function*() {
    const real = yield* Git;
    return Git.of({
      ...real,
      run: (path, args) => Effect.suspend(() => {
        commands.push(args);
        return real.run(path, args);
      })
    });
  })).pipe(Layer.provide(Git.layer));
  const core = CommentStore.layer(":memory:").pipe(Layer.merge(counted));
  const services = Watcher.layer({ root, intervalMs: 60_000 }).pipe(
    Layer.provideMerge(core),
    Layer.merge(Layer.succeed(ProjectConfig, {
      projectId: "anchor-test", repoRoot: root, dbPath: ":memory:", intervalMs: 60_000
    }))
  );
  const runtime = ManagedRuntime.make(ProjectReview.layer.pipe(Layer.provideMerge(services)));
  disposals.push(() => runtime.dispose());
  const create = (input: CreateCommentRequest) => runtime.runPromise(ProjectReview.use((review) => review.createComment(input)));
  const list = () => runtime.runPromise(ProjectReview.use((review) => review.listComments({})));
  const refresh = () => runtime.runPromise(Watcher.use((watcher) => watcher.refresh()));
  const carry = (id: string) => runtime.runPromise(ProjectReview.use((review) => review.updateComment(id, { carryForward: true })));
  return { directory, root, runtime, commands, create, list, refresh, carry };
}

function anchor(side: CommentSide, line = 20): CreateCommentRequest {
  return { file: "file.txt", side, line, lineText: `line ${line}`, body: "Review this" };
}

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("full-file comment anchors", () => {
  it("normalizes Git eol=crlf working-tree lines for previews, comments, and context", async () => {
    const { root, create, list, runtime } = await fixture();
    await writeFile(join(root, ".gitattributes"), "*.txt text eol=crlf\n");
    await git(root, ["add", ".gitattributes"]);
    await git(root, ["commit", "--quiet", "-m", "CRLF checkout"]);
    const changed = text.replace("line 2\n", "changed\n");
    await writeFile(join(root, "file.txt"), changed.replaceAll("\n", "\r\n"));
    const comment = await create({ ...anchor("new", 2), lineText: "changed" });
    expect(comment.context!.lines).toContainEqual({ line: 2, content: "changed" });
    expect((await list()).comments[0]).toMatchObject({ outdated: false });
    const diff = await runtime.runPromise(ProjectReview.use((review) => review.diff));
    expect(diff.files[0]!.hunks[0]!.lines).toContainEqual({ type: "add", newLine: 2, content: "changed" });
    const preview = await runtime.runPromise(ProjectReview.use((review) => review.file("file.txt")));
    expect(preview).toEqual({ path: "file.txt", kind: "text", content: changed });
    const context = await runtime.runPromise(ProjectReview.use((review) => review.file("file.txt", {
      context: true, reviewId: diff.reviewId
    })));
    expect(context).toEqual({ ...preview, baseContent: text, reviewId: diff.reviewId });
  });

  it("normalizes unfiltered tracked CRLF blobs and untracked files consistently", async () => {
    const { root, create, list, runtime } = await fixture();
    await git(root, ["config", "core.autocrlf", "false"]);
    await writeFile(join(root, "file.txt"), text.replaceAll("\n", "\r\n"));
    await git(root, ["add", "."]);
    await git(root, ["commit", "--quiet", "-m", "raw CRLF blob"]);
    await writeFile(join(root, "file.txt"), text.replace("line 2\n", "changed\n").replaceAll("\n", "\r\n"));
    await writeFile(join(root, "untracked.txt"), "first\r\nsecond\r\nlast\r");
    await create(anchor("old"));
    await create(anchor("new"));
    expect((await list()).comments.every((comment) => !comment.outdated)).toBe(true);
    const diff = await runtime.runPromise(ProjectReview.use((review) => review.diff));
    expect(diff.files.find((file) => file.newPath === "file.txt")!.hunks[0]!.lines.every((line) => !line.content.includes("\r"))).toBe(true);
    expect(diff.files.find((file) => file.newPath === "untracked.txt")!.hunks[0]!.lines.map((line) => line.content)).toEqual([
      "first", "second", "last\r"
    ]);
    expect(await runtime.runPromise(ProjectReview.use((review) => review.file("file.txt", { context: true })))).toMatchObject({ baseContent: text });
  });

  it("preserves raw symlink targets in previews, diff lines, and committed context", async () => {
    const { root, runtime, create, list } = await fixture();
    const target = "missing\r\nold\r";
    await symlink(target, join(root, "link"));
    await git(root, ["add", "link"]);
    await git(root, ["commit", "--quiet", "-m", "symlink"]);
    await rm(join(root, "link"));
    await symlink("missing\r\nnew\r", join(root, "link"));
    await symlink(target, join(root, "untracked-link"));
    await create({ file: "link", side: "new", line: 1, lineText: "missing\r", body: "target" });
    await create({ file: "link", side: "old", line: 1, lineText: "missing\r", body: "target" });
    expect((await list()).comments.every((comment) => !comment.outdated)).toBe(true);
    expect(await runtime.runPromise(ProjectReview.use((review) => review.file("link", { context: true })))).toMatchObject({
      kind: "symlink", content: "missing\r\nnew\r", baseContent: target
    });
    const diff = await runtime.runPromise(ProjectReview.use((review) => review.diff));
    for (const path of ["link", "untracked-link"]) {
      expect(diff.files.find((file) => file.newPath === path)!.hunks[0]!.lines[0]!.content).toBe("missing\r");
    }
  });
  it.each(["new", "old"] as const)("snapshots unchanged %s-side code and keeps it current", async (side) => {
    const { create, list, runtime } = await fixture();
    const comment = await create(anchor(side));
    expect(comment.context).toEqual({
      source: "snapshot", line: 20,
      lines: lines.slice(16, 23).map((content, index) => ({ line: index + 17, content }))
    });
    expect((await list()).comments).toEqual([expect.objectContaining({
      id: comment.id, historical: false, outdated: false, context: comment.context
    })]);
    expect((await runtime.runPromise(ProjectReview.use((review) => review.diff))).files).toEqual([]);
  });

  it.each(["new", "old"] as const)("resolves %s-side lines outside hunks, then outside the diff", async (side) => {
    const { root, create, list, refresh, runtime } = await fixture();
    await writeFile(join(root, "file.txt"), text.replace("line 2\n", "changed\n"));
    const comment = await create(anchor(side));
    const diff = await runtime.runPromise(ProjectReview.use((review) => review.diff));
    expect(diff.files[0]!.hunks.flatMap((hunk) => hunk.lines).some((line) => line.content === "line 20")).toBe(false);
    expect(comment.context).toMatchObject({ source: "snapshot", line: 20 });
    expect((await list()).comments[0]).toMatchObject({ outdated: false });
    await writeFile(join(root, "file.txt"), text);
    await refresh();
    expect((await list()).comments[0]).toMatchObject({ outdated: false, context: comment.context });
  });

  it("moves new-side anchors to the nearest matching line without moving saved excerpts", async () => {
    const { root, create, list, runtime } = await fixture();
    const original = text.replace("line 5\n", "repeat\n").replace("line 20\n", "repeat\n");
    await writeFile(join(root, "file.txt"), original);
    const comment = await create({ ...anchor("new"), lineText: "repeat" });
    await writeFile(join(root, "file.txt"), `prefix\n${original}`);
    expect((await list()).comments[0]).toMatchObject({ line: 21, outdated: false, context: comment.context });
    const saved = await runtime.runPromise(CommentStore.use((store) => store.get(comment.id)));
    expect(saved).toMatchObject({ line: 21, context: { line: 20 } });
    await writeFile(join(root, "file.txt"), original.replaceAll("repeat", "gone"));
    expect((await list()).comments[0]).toMatchObject({ line: 21, outdated: true, context: comment.context });
  });

  it("reads renamed old-side anchors from the original HEAD path", async () => {
    const { root, create, list, commands } = await fixture();
    await git(root, ["mv", "file.txt", "renamed.txt"]);
    await writeFile(join(root, "renamed.txt"), text.replace("line 20\n", "new side only\n"));
    const old = await create({ ...anchor("old"), file: "renamed.txt" });
    const current = await create({ ...anchor("new"), file: "renamed.txt", lineText: "new side only" });
    expect(old.context!.lines).toContainEqual({ line: 20, content: "line 20" });
    expect(current.context!.lines).toContainEqual({ line: 20, content: "new side only" });
    expect((await list()).comments.every((comment) => !comment.outdated)).toBe(true);
    expect(commands.filter((args) => args[0] === "cat-file" && args[1] === "blob")).toEqual([
      ["cat-file", "blob", expect.stringMatching(/:file\.txt$/)]
    ]);
  });

  it("preserves review scoping and carries addressed comments into a clean review", async () => {
    const { root, create, list, refresh, carry, runtime } = await fixture();
    const comment = await create(anchor("new"));
    await runtime.runPromise(ProjectReview.use((review) => review.updateComment(comment.id, { status: "addressed" })));
    await writeFile(join(root, "file.txt"), `prefix\n${text}`);
    await git(root, ["add", "."]);
    await git(root, ["commit", "--quiet", "-m", "next review"]);
    await refresh();
    expect((await list()).comments[0]).toMatchObject({
      historical: true, outdated: true, line: 20, context: comment.context
    });
    const carried = await carry(comment.id);
    expect(carried).toMatchObject({ status: "addressed", line: 21, context: { source: "snapshot", line: 21 } });
    expect(carried.reviewId).not.toBe(comment.reviewId);
    expect((await list()).comments[0]).toMatchObject({ historical: false, outdated: false });
  });

  it("rejects missing content in readable files but accepts and relocates a moved anchor", async () => {
    const { root, create } = await fixture();
    await writeFile(join(root, "file.txt"), `prefix\n${text}`);
    const moved = await create(anchor("new"));
    expect(moved).toMatchObject({ line: 21, context: { line: 21 } });
    await expect(create({ ...anchor("new"), lineText: "not in the file" })).rejects.toMatchObject({
      _tag: "BadRequestError", error: "This line changed. Refresh the file before adding a comment."
    });
  });

  it.each(["missing", "binary", "large"] as const)("retains diff fallback when working-tree contents are %s", async (kind) => {
    const { root, create, list } = await fixture();
    await writeFile(join(root, "file.txt"), text.replace("line 20\n", "changed\n"));
    const comment = await create({ ...anchor("new"), lineText: "changed" });
    if (kind === "missing") await rm(join(root, "file.txt"));
    else await writeFile(join(root, "file.txt"), kind === "binary" ? "\0binary" : "x".repeat(1024 * 1024 + 1));
    expect((await list()).comments[0]).toMatchObject({ outdated: false, context: comment.context });
  });

  it("bounds committed reads and keeps old-side diff fallback for large files", async () => {
    const { root, create, list, commands } = await fixture();
    const large = `target\n${"padding\n".repeat(150_000)}`;
    await writeFile(join(root, "file.txt"), large);
    await git(root, ["add", "."]);
    await git(root, ["commit", "--quiet", "-m", "large file"]);
    await writeFile(join(root, "file.txt"), large.replace("target\n", "replacement\n"));
    const comment = await create({ ...anchor("old", 1), lineText: "target" });
    expect(comment.context).toMatchObject({ source: "snapshot", line: 1 });
    expect((await list()).comments[0]).toMatchObject({ outdated: false });
    expect(commands.filter((args) => args[0] === "cat-file" && args[1] === "blob")).toEqual([]);
  });

  it("lists once per request and caches committed contents across comments and requests", async () => {
    const { runtime, list, commands, refresh } = await fixture();
    await refresh();
    await runtime.runPromise(Effect.gen(function*() {
      const store = yield* CommentStore;
      const { reviewId } = yield* (yield* Watcher).snapshot;
      for (const side of ["new", "old"] as const) {
        for (const line of [10, 20, 30]) {
          yield* store.create({ ...anchor(side, line), reviewId, author: "user" });
        }
      }
    }));
    expect((await list()).comments.every((comment) => !comment.outdated)).toBe(true);
    expect(commands.filter((args) => args[0] === "ls-files")).toHaveLength(1);
    expect(commands.filter((args) => args[0] === "cat-file" && args[1] === "blob")).toHaveLength(1);
    await list();
    expect(commands.filter((args) => args[0] === "cat-file" && args[1] === "blob")).toHaveLength(1);
  });

  it("never reads ignored paths, traversal paths, or symlink targets", async () => {
    const { directory, root, runtime, list, refresh } = await fixture();
    await writeFile(join(directory, "secret.txt"), "secret\n");
    await writeFile(join(root, ".gitignore"), "ignored.txt\n");
    await writeFile(join(root, "ignored.txt"), "secret\n");
    await symlink(join(directory, "secret.txt"), join(root, "link.txt"));
    await symlink(directory, join(root, "linked-dir"));
    await refresh();
    await runtime.runPromise(Effect.gen(function*() {
      const store = yield* CommentStore;
      const { reviewId } = yield* (yield* Watcher).snapshot;
      for (const file of ["../secret.txt", "ignored.txt", "link.txt", "linked-dir/secret.txt"]) {
        yield* store.create({ ...anchor("new", 1), file, lineText: "secret", reviewId, author: "user" });
      }
    }));
    for (const comment of (await list()).comments) {
      expect(comment).toMatchObject({ outdated: true });
      expect(comment.context).toBeUndefined();
    }
  });

  it("supplies cached original-path base content for renamed files and empty bases for additions", async () => {
    const { root, runtime, commands, create } = await fixture();
    await git(root, ["mv", "file.txt", "renamed.txt"]);
    await writeFile(join(root, "renamed.txt"), text.replace("line 20\n", "changed\n"));
    await writeFile(join(root, "added.txt"), "new\n");
    const context = await runtime.runPromise(ProjectReview.use((review) => review.file("renamed.txt", { context: true })));
    expect(context).toMatchObject({ baseContent: text, reviewId: expect.any(String) });
    await create({ ...anchor("old"), file: "renamed.txt" });
    await runtime.runPromise(ProjectReview.use((review) => review.file("renamed.txt", { context: true })));
    expect(commands.filter((args) => args[0] === "cat-file" && args[1] === "blob")).toEqual([
      ["cat-file", "blob", expect.stringMatching(/:file\.txt$/)]
    ]);
    expect(await runtime.runPromise(ProjectReview.use((review) => review.file("added.txt", { context: true })))).toMatchObject({
      baseContent: "", reviewId: context.reviewId
    });
    await git(root, ["checkout", "--orphan", "unborn"]);
    expect(await runtime.runPromise(ProjectReview.use((review) => review.file("renamed.txt", { context: true })))).toMatchObject({ baseContent: "" });
  });

  it.each(["binary", "large"] as const)("returns a null %s base without unbounded blob reads", async (kind) => {
    const { root, runtime, commands } = await fixture();
    await writeFile(join(root, "file.txt"), kind === "binary" ? "a\0b" : "x".repeat(1024 * 1024 + 1));
    await git(root, ["add", "."]);
    await git(root, ["commit", "--quiet", "-m", kind]);
    await writeFile(join(root, "file.txt"), "readable replacement\n");
    expect(await runtime.runPromise(ProjectReview.use((review) => review.file("file.txt", { context: true })))).toMatchObject({
      content: "readable replacement\n", baseContent: null
    });
    if (kind === "large") expect(commands.filter((args) => args[0] === "cat-file" && args[1] === "blob")).toEqual([]);
  });

  it("refreshes the watcher before rejecting context from a previous review", async () => {
    const { root, runtime } = await fixture();
    const before = await runtime.runPromise(ProjectReview.use((review) => review.file("file.txt", { context: true })));
    await git(root, ["commit", "--allow-empty", "--quiet", "-m", "next"]);
    await expect(runtime.runPromise(ProjectReview.use((review) => review.file("file.txt", {
      context: true, reviewId: before.reviewId
    })))).rejects.toMatchObject({ _tag: "BadRequestError" });
    const after = await runtime.runPromise(ProjectReview.use((review) => review.file("file.txt", { context: true })));
    expect(after.reviewId).not.toBe(before.reviewId);
    expect(after.baseContent).toBe(text);
  });

  it("recovers legacy HEAD excerpts without persisting or changing review membership", async () => {
    const { runtime, list } = await fixture();
    const saved = await runtime.runPromise(CommentStore.use((store) => store.create({ ...anchor("new"), author: "user" })));
    const comment = (await list()).comments[0]!;
    expect(comment).toMatchObject({ historical: true, outdated: true, context: { source: "head", line: 20 } });
    expect((await runtime.runPromise(CommentStore.use((store) => store.get(saved.id))))!.context).toBeUndefined();
  });
});

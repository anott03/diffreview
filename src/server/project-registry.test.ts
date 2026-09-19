import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, ManagedRuntime, Option } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { ServerConfig } from "./config";
import { Git, GitError } from "./git";
import { repoHash } from "./paths";
import { ProjectCatalog } from "./project-catalog";
import { ProjectRegistry } from "./project-registry";
import { resolveProjectPath } from "./project-path";
import { CommentStore } from "./store";

const exec = promisify(execFile);
const git = (cwd: string, args: string[]) => exec("git", args, { cwd });
const directories: string[] = [];
const disposals: (() => Promise<void>)[] = [];

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "diffreview-registry-"));
  directories.push(directory);
  const root = join(directory, "repo");
  await mkdir(root);
  await git(root, ["init", "--quiet"]);
  await writeFile(join(root, "file.txt"), "review me\n");
  const data = join(directory, "data");
  await mkdir(data);
  return { directory, root, data };
}

function registry(data: string, gitLayer = Git.layer) {
  const core = gitLayer.pipe(
    Layer.merge(ProjectCatalog.layer(join(data, "projects.sqlite"))),
    Layer.merge(Layer.succeed(ServerConfig, { port: 0, intervalMs: 20, webRoot: null, instanceId: "registry-test", startedAt: 1 }))
  );
  const runtime = ManagedRuntime.make(ProjectRegistry.layer.pipe(Layer.provideMerge(core)));
  disposals.push(() => runtime.dispose());
  return runtime;
}

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("project registry lifecycle", () => {
  it("starts with no selected project and keeps catalogued projects unloaded until requested", async () => {
    const { root, data } = await fixture();
    let polls = 0;
    const counted = Layer.effect(Git, Effect.gen(function*() {
      const real = yield* Git;
      return Git.of({ ...real, collectState: (path) => Effect.suspend(() => { polls++; return real.collectState(path); }) });
    })).pipe(Layer.provide(Git.layer));
    const first = registry(data, counted);
    expect(await first.runPromise(Effect.gen(function*() { return yield* (yield* ProjectRegistry).projects; }))).toEqual([]);
    expect(polls).toBe(0);
    await first.runPromise(Effect.gen(function*() { return yield* (yield* ProjectRegistry).open(root); }));
    await first.dispose();
    polls = 0;
    const second = registry(data, counted);
    const known = await second.runPromise(Effect.gen(function*() { return yield* (yield* ProjectRegistry).projects; }));
    expect(known).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(polls).toBe(0);
    await second.runPromise(Effect.gen(function*() { return yield* (yield* ProjectRegistry).get(known[0]!.id); }));
    expect(polls).toBeGreaterThan(0);
  });

  it("deduplicates concurrent aliases, retains runtimes, and closes polling and SQLite with its scope", async () => {
    const { directory, root, data } = await fixture();
    const alias = join(directory, "alias");
    await symlink(root, alias);
    await mkdir(join(root, "subdir"));
    let polls = 0;
    const counted = Layer.effect(Git, Effect.gen(function*() {
      const real = yield* Git;
      return Git.of({ ...real, collectState: (path) => Effect.suspend(() => { polls++; return real.collectState(path); }) });
    })).pipe(Layer.provide(Git.layer));
    const runtime = registry(data, counted);
    const projects = await runtime.runPromise(Effect.gen(function*() {
      const registry = yield* ProjectRegistry;
      return yield* Effect.all([root, alias, join(alias, "subdir"), root].map((path) => registry.open(path)), { concurrency: "unbounded" });
    }));
    expect(new Set(projects.map((p) => p.id)).size).toBe(1);
    expect(projects[0]!.id).toBe(repoHash(root));
    const runtimes = await runtime.runPromise(Effect.gen(function*() {
      const registry = yield* ProjectRegistry;
      return yield* Effect.all(projects.map((p) => registry.get(p.id)), { concurrency: "unbounded" });
    }));
    for (const project of runtimes) expect(project).toBe(runtimes[0]);
    await runtime.dispose();
    const stoppedAt = polls;
    await writeFile(join(root, "file.txt"), "changed after shutdown\n");
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(polls).toBe(stoppedAt);
    const closed = await Effect.runPromiseExit(runtimes[0]!.watcher.refresh());
    expect(Exit.isFailure(closed)).toBe(true);
    if (Exit.isFailure(closed)) expect(String(closed.cause)).toContain("database is not open");
  });

  it("releases partial initialization, retains catalog metadata, and retries without poisoning other projects", async () => {
    const { root, data, directory } = await fixture();
    const otherRoot = join(directory, "other");
    await mkdir(otherRoot);
    await git(otherRoot, ["init", "--quiet"]);
    let failed = false;
    const flaky = Layer.effect(Git, Effect.gen(function*() {
      const real = yield* Git;
      return Git.of({
        ...real,
        collectState: (path) => {
          if (path === root && !failed) {
            failed = true;
            return Effect.fail(new GitError({ args: ["status"], cause: new Error("temporarily unavailable") }));
          }
          return real.collectState(path);
        }
      });
    })).pipe(Layer.provide(Git.layer));
    const runtime = registry(data, flaky);
    const failure = await runtime.runPromise(Effect.gen(function*() {
      const registry = yield* ProjectRegistry;
      return yield* Effect.exit(registry.open(root));
    }));
    expect(Exit.isFailure(failure)).toBe(true);
    if (Exit.isFailure(failure)) expect(Option.getOrThrow(Cause.findErrorOption(failure.cause)).error).toContain("temporarily unavailable");
    const projects = await runtime.runPromise(Effect.gen(function*() { return yield* (yield* ProjectRegistry).projects; }));
    expect(projects).toHaveLength(1);
    await runtime.runPromise(Effect.gen(function*() { return yield* (yield* ProjectRegistry).open(otherRoot); }));
    const restored = await runtime.runPromise(Effect.gen(function*() { return yield* (yield* ProjectRegistry).get(projects[0]!.id); }));
    expect((await Effect.runPromise(restored.review.diff)).files).toHaveLength(1);
  });

  it("owns initialization independently of the requesting fiber", async () => {
    const { root, data } = await fixture();
    const entered = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    let initializations = 0;
    const gated = Layer.effect(Git, Effect.gen(function*() {
      const real = yield* Git;
      return Git.of({ ...real, collectState: (path) => Effect.gen(function*() {
        initializations++;
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(release);
        return yield* real.collectState(path);
      }) });
    })).pipe(Layer.provide(Git.layer));
    const runtime = registry(data, gated);
    await runtime.runPromise(Effect.scoped(Effect.gen(function*() {
      const registry = yield* ProjectRegistry;
      const caller = yield* Effect.forkScoped(registry.open(root));
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(caller);
      yield* Deferred.succeed(release, undefined);
      const retained = yield* registry.get(repoHash(root));
      expect((yield* retained.review.diff).files).toHaveLength(1);
      expect(initializations).toBe(1);
    })));
  });

  it("keeps linked worktrees distinct from the main working tree", async () => {
    const { directory, root, data } = await fixture();
    await git(root, ["-c", "user.name=Test", "-c", "user.email=t@t.t", "commit", "--allow-empty", "-m", "init", "--quiet"]);
    const worktree = join(directory, "worktree");
    await git(root, ["worktree", "add", "--detach", worktree]);
    const runtime = registry(data);
    const projects = await runtime.runPromise(Effect.gen(function*() {
      const registry = yield* ProjectRegistry;
      return yield* Effect.all([registry.open(root), registry.open(worktree)], { concurrency: "unbounded" });
    }));
    expect(projects[0]!.id).not.toBe(projects[1]!.id);
    expect(await resolveProjectPath(worktree)).toBe(worktree);
  });

  it("reuses a legacy alias database and preserves review and comment history across restart", async () => {
    const { directory, root, data } = await fixture();
    const alias = join(directory, "alias");
    await symlink(root, alias);
    const oldPath = join(data, `${repoHash(alias)}.sqlite`);
    const saved = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const store = yield* CommentStore;
      const reviewId = yield* store.currentReview("");
      return yield* store.create({ reviewId, file: "file.txt", side: "new", line: 1, lineText: "review me", body: "legacy", author: "user" });
    }).pipe(Effect.provide(CommentStore.layer(oldPath)))));
    await mkdir(join(data, "sessions"));
    await writeFile(join(data, "sessions", `${repoHash(alias)}.json`), JSON.stringify({ repoRoot: alias }));
    const first = registry(data);
    const project = await first.runPromise(Effect.gen(function*() { return yield* (yield* ProjectRegistry).open(root); }));
    const comments = await first.runPromise(Effect.gen(function*() {
      const runtime = yield* (yield* ProjectRegistry).get(project.id);
      return yield* runtime.review.listComments({});
    }));
    expect(comments.comments).toEqual([expect.objectContaining({ id: saved.id, reviewId: saved.reviewId, historical: false })]);
    await first.dispose();
    await rm(join(data, "sessions"), { recursive: true });
    const second = registry(data);
    const diff = await second.runPromise(Effect.gen(function*() {
      const runtime = yield* (yield* ProjectRegistry).get(project.id);
      return yield* runtime.review.diff;
    }));
    expect(diff.reviewId).toBe(saved.reviewId);
  });

  it("refuses to recreate a missing known database during lazy loading and retries after restoration", async () => {
    const { root, data } = await fixture();
    const first = registry(data);
    const project = await first.runPromise(ProjectRegistry.use((registry) => registry.open(root)));
    const saved = await first.runPromise(ProjectRegistry.use((registry) => Effect.gen(function*() {
      const runtime = yield* registry.get(project.id);
      return yield* runtime.review.diff;
    })));
    await first.dispose();
    const path = join(data, `${project.id}.sqlite`);
    const backup = `${path}.backup`;
    await rename(path, backup);
    const second = registry(data);
    const failure = await second.runPromise(ProjectRegistry.use((registry) => Effect.exit(registry.get(project.id))));
    expect(Exit.isFailure(failure)).toBe(true);
    if (Exit.isFailure(failure)) {
      expect(Option.getOrThrow(Cause.findErrorOption(failure.cause)).error).toContain(`database ${path} is missing`);
    }
    expect(existsSync(path)).toBe(false);
    const reopen = await second.runPromise(ProjectRegistry.use((registry) => Effect.exit(registry.open(root))));
    expect(Exit.isFailure(reopen)).toBe(true);
    expect(existsSync(path)).toBe(false);
    await rename(backup, path);
    const restored = await second.runPromise(ProjectRegistry.use((registry) => registry.get(project.id)));
    expect((await Effect.runPromise(restored.review.diff)).reviewId).toBe(saved.reviewId);
  });

  it("does not substitute a canonical database for a missing catalogued alias database on lazy load", async () => {
    const { directory, root, data } = await fixture();
    const alias = join(directory, "alias");
    await symlink(root, alias);
    const aliasPath = join(data, `${repoHash(alias)}.sqlite`);
    await Effect.runPromise(CommentStore.use((store) => store.currentReview("legacy")).pipe(
      Effect.provide(CommentStore.layer(aliasPath))
    ));
    const first = registry(data);
    const project = await first.runPromise(ProjectRegistry.use((registry) => registry.open(alias)));
    await first.dispose();
    await rename(aliasPath, `${aliasPath}.backup`);
    const canonicalPath = join(data, `${project.id}.sqlite`);
    const replacementReview = await Effect.runPromise(CommentStore.use((store) => store.currentReview("replacement")).pipe(
      Effect.provide(CommentStore.layer(canonicalPath))
    ));
    const second = registry(data);
    const failure = await second.runPromise(ProjectRegistry.use((registry) => Effect.exit(registry.get(project.id))));
    expect(Exit.isFailure(failure)).toBe(true);
    if (Exit.isFailure(failure)) {
      const message = Option.getOrThrow(Cause.findErrorOption(failure.cause)).error;
      expect(message).toContain(`${aliasPath} is missing, but ${canonicalPath} exists`);
    }
    expect(existsSync(aliasPath)).toBe(false);
    const untouchedReview = await Effect.runPromise(CommentStore.use((store) => store.currentReview("replacement")).pipe(
      Effect.provide(CommentStore.layer(canonicalPath))
    ));
    expect(untouchedReview).toBe(replacementReview);
  });

  it("allows a newly catalogued project to create its first database after restart", async () => {
    const { root, data } = await fixture();
    const first = registry(data);
    const project = await first.runPromise(ProjectCatalog.use((catalog) => catalog.register(root, root)));
    const path = join(data, `${project.id}.sqlite`);
    expect(existsSync(path)).toBe(false);
    await first.dispose();
    const second = registry(data);
    await second.runPromise(ProjectRegistry.use((registry) => registry.get(project.id)));
    expect(existsSync(path)).toBe(true);
  });

  it("treats pre-migration catalog databases as known rather than new", async () => {
    const { root, data } = await fixture();
    const id = repoHash(root);
    const path = join(data, `${id}.sqlite`);
    const catalog = new DatabaseSync(join(data, "projects.sqlite"));
    catalog.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE, name TEXT NOT NULL, openedAt INTEGER NOT NULL, dbPath TEXT NOT NULL UNIQUE)");
    catalog.prepare("INSERT INTO projects VALUES (?, ?, ?, ?, ?)").run(id, root, "repo", 1, path);
    catalog.close();
    const runtime = registry(data);
    const failure = await runtime.runPromise(ProjectRegistry.use((registry) => Effect.exit(registry.get(id))));
    expect(Exit.isFailure(failure)).toBe(true);
    if (Exit.isFailure(failure)) {
      expect(Option.getOrThrow(Cause.findErrorOption(failure.cause)).error).toContain(`database ${path} is missing`);
    }
    expect(existsSync(path)).toBe(false);
  });

  it.each(["canonical", "alias"] as const)("rechecks conflicts against a catalogued %s database on lazy load and allows retry", async (initial) => {
    const { directory, root, data } = await fixture();
    const alias = join(directory, "alias");
    await symlink(root, alias);
    const canonicalPath = join(data, `${repoHash(root)}.sqlite`);
    const aliasPath = join(data, `${repoHash(alias)}.sqlite`);
    const original = initial === "canonical" ? canonicalPath : aliasPath;
    const conflicting = initial === "canonical" ? aliasPath : canonicalPath;
    const saved = await Effect.runPromise(CommentStore.use((store) => store.create({
      file: "file.txt", side: "new", line: 1, lineText: "review me", body: "keep history", author: "user"
    })).pipe(Effect.provide(CommentStore.layer(original))));
    const first = registry(data);
    const project = await first.runPromise(ProjectRegistry.use((registry) => registry.open(alias)));
    await first.dispose();
    if (initial === "canonical") {
      await mkdir(join(data, "sessions"));
      await writeFile(join(data, "sessions", `${repoHash(alias)}.json`), JSON.stringify({ repoRoot: alias }));
    }
    await Effect.runPromise(CommentStore.use((store) => store.currentReview("conflicting")).pipe(
      Effect.provide(CommentStore.layer(conflicting))
    ));
    const second = registry(data);
    const failure = await second.runPromise(ProjectRegistry.use((registry) => Effect.exit(registry.get(project.id))));
    expect(Exit.isFailure(failure)).toBe(true);
    if (Exit.isFailure(failure)) {
      const message = Option.getOrThrow(Cause.findErrorOption(failure.cause)).error;
      expect(message).toContain("Multiple comment databases");
      expect(message).toContain(original);
      expect(message).toContain(conflicting);
    }
    await rm(conflicting);
    const restored = await second.runPromise(ProjectRegistry.use((registry) => registry.get(project.id)));
    const comments = await Effect.runPromise(restored.review.listComments({}));
    expect(comments.comments).toEqual([expect.objectContaining({ id: saved.id, body: saved.body })]);
  });

  it("refuses ambiguous canonical and alias databases without dropping either history", async () => {
    const { directory, root, data } = await fixture();
    const alias = join(directory, "alias");
    await symlink(root, alias);
    for (const path of [root, alias]) {
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const store = yield* CommentStore;
        yield* store.create({ file: "file.txt", side: "new", line: 1, lineText: "review me", body: path, author: "user" });
      }).pipe(Effect.provide(CommentStore.layer(join(data, `${repoHash(path)}.sqlite`))))));
    }
    const runtime = registry(data);
    const result = await runtime.runPromise(Effect.gen(function*() {
      return yield* Effect.exit((yield* ProjectRegistry).open(alias));
    }));
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) expect(Option.getOrThrow(Cause.findErrorOption(result.cause)).error).toContain("Multiple comment databases");
  });
});

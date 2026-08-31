import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber, Layer, Option, Stream, type Scope } from "effect";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { Git } from "./git";
import { Watcher } from "./watcher";

const execFileAsync = promisify(execFile);
const git = (cwd: string, args: string[]) => execFileAsync("git", args, { cwd });

const dirs: string[] = [];

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "diffreview-watcher-"));
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

// Long interval: the poll loop must not interfere with tests (it sleeps
// before its first refresh, so nothing automatic happens during a test).
const watcherLayer = (root: string) =>
  Watcher.layer({ root, intervalMs: 60_000 }).pipe(Layer.provide(Git.layer));

// Real time + real fs/git — TestClock's virtual sleep would hang these.
const withRepo = <A, E>(
  f: (dir: string) => Effect.Effect<A, E, Watcher | Scope.Scope>
): Effect.Effect<A, E, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.promise(makeRepo),
    (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true }))
  ).pipe(Effect.flatMap((dir) => f(dir).pipe(Effect.provide(watcherLayer(dir)))));

describe("Watcher (Effect service)", () => {
  it.live("starts empty, populates on refresh, and is hash-stable", () =>
    withRepo((dir) =>
      Effect.gen(function*() {
        const w = yield* Watcher;

        expect(yield* w.files).toEqual([]);

        // Clean repo (everything committed) → empty diff; first refresh
        // still transitions from "no state" to "state".
        expect(yield* w.refresh()).toBe(true);
        expect(yield* w.files).toEqual([]);

        // Uncommitted change → parsed diff appears.
        yield* Effect.promise(() => writeFile(join(dir, "a.txt"), "one\nTWO\nthree\n"));
        expect(yield* w.refresh()).toBe(true);
        const files = yield* w.files;
        expect(files).toHaveLength(1);
        expect(files[0]!.newPath).toBe("a.txt");
        expect(files[0]!.additions).toBe(1);

        // Same state → no re-parse, no event.
        expect(yield* w.refresh()).toBe(false);
      })
    ));

  it.live("publishes a diff event on the changes stream when the diff changes", () =>
    withRepo((dir) =>
      Effect.gen(function*() {
        const w = yield* Watcher;
        yield* w.refresh();

        // Subscribe before changing the repo.
        const headFiber = yield* Effect.forkScoped(Stream.runHead(w.changes));
        yield* Effect.sleep(20);

        yield* Effect.promise(() => writeFile(join(dir, "a.txt"), "one\nTWO\nthree\n"));
        expect(yield* w.refresh()).toBe(true);

        const head = yield* Fiber.join(headFiber);
        expect(Option.isSome(head)).toBe(true);
        const event = Option.getOrThrow(head);
        expect(event.type).toBe("diff");
        expect(event.at).toBeGreaterThan(0);
      })
    ));

  it.live("publish() delivers manual events to the changes stream", () =>
    withRepo((dir) =>
      Effect.gen(function*() {
        void dir;
        const w = yield* Watcher;

        const headFiber = yield* Effect.forkScoped(Stream.runHead(w.changes));
        yield* Effect.sleep(20);

        const published = yield* w.publish({ type: "comments", at: 12345 });
        expect(published).toBe(true);

        const head = yield* Fiber.join(headFiber);
        expect(Option.getOrThrow(head)).toEqual({ type: "comments", at: 12345 });
      })
    ));
});

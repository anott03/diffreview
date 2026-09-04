/**
 * Tests for the `CommentStore` Effect service.
 *
 * The legacy `CommentStoreCompat` class delegates to the same sync core
 * functions, so these cases cover both implementations' SQL behavior.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { CommentStore, StoreError } from "./store";

const baseInput = {
  file: "src/a.ts",
  side: "new" as const,
  line: 12,
  lineText: "const x = 1;",
  body: "rename this variable",
  author: "user" as const,
};

const withMemoryStore = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(CommentStore.layer(":memory:")));

describe("CommentStore (Effect service)", () => {
  it.effect("creates comments with open status by default", () =>
    Effect.gen(function*() {
      const store = yield* CommentStore;
      const c = yield* store.create(baseInput);
      expect(c.id).toBeTruthy();
      expect(c.status).toBe("open");
      expect(c.note).toBeUndefined();
      expect(c.createdAt).toBeGreaterThan(0);
    }).pipe(withMemoryStore));

  it.effect("lists with status and file filters", () =>
    Effect.gen(function*() {
      const store = yield* CommentStore;
      const a = yield* store.create(baseInput);
      const b = yield* store.create({ ...baseInput, file: "src/b.ts" });
      yield* store.create({ ...baseInput, file: "src/b.ts" });
      yield* store.update(b.id, { status: "addressed" });

      expect(yield* store.list()).toHaveLength(3);
      expect(yield* store.list({ status: "open" })).toHaveLength(2);
      expect((yield* store.list({ status: "addressed" })).map((c) => c.id)).toEqual([b.id]);
      expect(yield* store.list({ file: "src/b.ts" })).toHaveLength(2);
      expect((yield* store.list({ status: "open", file: "src/a.ts" })).map((c) => c.id)).toEqual([
        a.id,
      ]);
    }).pipe(withMemoryStore));

  it.effect("updates status, note, body, and line", () =>
    Effect.gen(function*() {
      const store = yield* CommentStore;
      const c = yield* store.create(baseInput);
      const updated = yield* store.update(c.id, {
        status: "addressed",
        note: "renamed to count",
        line: 14,
      });
      expect(updated!.status).toBe("addressed");
      expect(updated!.note).toBe("renamed to count");
      expect(updated!.line).toBe(14);
      expect(updated!.updatedAt).toBeGreaterThanOrEqual(c.updatedAt);

      const rebodied = yield* store.update(c.id, { body: "edited body" });
      expect(rebodied!.body).toBe("edited body");
      expect(rebodied!.note).toBe("renamed to count"); // untouched fields preserved
    }).pipe(withMemoryStore));

  it.effect("returns null when updating a missing comment", () =>
    Effect.gen(function*() {
      const store = yield* CommentStore;
      expect(yield* store.update("nope", { status: "addressed" })).toBeNull();
    }).pipe(withMemoryStore));

  it.effect("removes comments", () =>
    Effect.gen(function*() {
      const store = yield* CommentStore;
      const c = yield* store.create(baseInput);
      expect(yield* store.remove(c.id)).toBe(true);
      expect(yield* store.remove(c.id)).toBe(false);
      expect(yield* store.get(c.id)).toBeNull();
    }).pipe(withMemoryStore));

  it.effect("persists across reopen", () =>
    Effect.gen(function*() {
      const dir = mkdtempSync(join(tmpdir(), "diffreview-store-"));
      try {
        const dbPath = join(dir, "test.sqlite");
        const created = yield* Effect.gen(function*() {
          const store = yield* CommentStore;
          return yield* store.create(baseInput);
        }).pipe(Effect.provide(CommentStore.layer(dbPath)));

        const loaded = yield* Effect.gen(function*() {
          const store = yield* CommentStore;
          return yield* store.get(created.id);
        }).pipe(Effect.provide(CommentStore.layer(dbPath)));

        expect(loaded).not.toBeNull();
        expect(loaded!.body).toBe(baseInput.body);
        expect(loaded!.lineText).toBe(baseInput.lineText);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }));

  it.effect("fails with StoreError(op=open) when the database cannot be opened", () =>
    Effect.gen(function*() {
      // A *file* used as a directory makes mkdir/open fail deterministically.
      const block = join(tmpdir(), `diffreview-store-block-${Date.now()}`);
      writeFileSync(block, "not a directory");
      try {
        const error = yield* Effect.flip(
          Effect.gen(function*() {
            const store = yield* CommentStore;
            return yield* store.list();
          }).pipe(Effect.provide(CommentStore.layer(join(block, "nested", "x.sqlite"))))
        );
        expect(error).toBeInstanceOf(StoreError);
        expect(error.op).toBe("open");
      } finally {
        rmSync(block, { force: true });
      }
    }));

  it("layer builds produce independent instances", async () => {
    // Two builds of the same :memory: layer must not share state.
    const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
    const a = await run(
      Effect.gen(function*() {
        const store = yield* CommentStore;
        return yield* store.create(baseInput);
      }).pipe(withMemoryStore)
    );
    const b = await run(
      Effect.gen(function*() {
        const store = yield* CommentStore;
        return (yield* store.list()).length;
      }).pipe(withMemoryStore)
    );
    expect(b).toBe(0); // fresh in-memory db, not the one holding `a`
    expect(a.id).toBeTruthy();
  });
});

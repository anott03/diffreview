import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CommentStore } from "./store";

const baseInput = {
  file: "src/a.ts",
  side: "new" as const,
  line: 12,
  lineText: "const x = 1;",
  body: "rename this variable",
  author: "user" as const,
};

describe("CommentStore", () => {
  let store: CommentStore;

  afterEach(() => store?.close());

  it("creates comments with open status by default", () => {
    store = new CommentStore(":memory:");
    const c = store.create(baseInput);
    expect(c.id).toBeTruthy();
    expect(c.status).toBe("open");
    expect(c.note).toBeUndefined();
    expect(c.createdAt).toBeGreaterThan(0);
  });

  it("lists with status and file filters", () => {
    store = new CommentStore(":memory:");
    const a = store.create(baseInput);
    const b = store.create({ ...baseInput, file: "src/b.ts" });
    store.create({ ...baseInput, file: "src/b.ts" });
    store.update(b.id, { status: "addressed" });

    expect(store.list()).toHaveLength(3);
    expect(store.list({ status: "open" })).toHaveLength(2);
    expect(store.list({ status: "addressed" }).map((c) => c.id)).toEqual([b.id]);
    expect(store.list({ file: "src/b.ts" })).toHaveLength(2);
    expect(store.list({ status: "open", file: "src/a.ts" }).map((c) => c.id)).toEqual([a.id]);
  });

  it("updates status, note, body, and line", () => {
    store = new CommentStore(":memory:");
    const c = store.create(baseInput);
    const updated = store.update(c.id, {
      status: "addressed",
      note: "renamed to count",
      line: 14,
    });
    expect(updated!.status).toBe("addressed");
    expect(updated!.note).toBe("renamed to count");
    expect(updated!.line).toBe(14);
    expect(updated!.updatedAt).toBeGreaterThanOrEqual(c.updatedAt);

    const rebodied = store.update(c.id, { body: "edited body" });
    expect(rebodied!.body).toBe("edited body");
    expect(rebodied!.note).toBe("renamed to count"); // untouched fields preserved
  });

  it("returns null when updating a missing comment", () => {
    store = new CommentStore(":memory:");
    expect(store.update("nope", { status: "addressed" })).toBeNull();
  });

  it("removes comments", () => {
    store = new CommentStore(":memory:");
    const c = store.create(baseInput);
    expect(store.remove(c.id)).toBe(true);
    expect(store.remove(c.id)).toBe(false);
    expect(store.get(c.id)).toBeNull();
  });

  it("persists across reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "diffreview-store-"));
    try {
      const dbPath = join(dir, "test.sqlite");
      const first = new CommentStore(dbPath);
      const c = first.create(baseInput);
      first.close();

      store = new CommentStore(dbPath);
      const loaded = store.get(c.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.body).toBe(baseInput.body);
      expect(loaded!.lineText).toBe(baseInput.lineText);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

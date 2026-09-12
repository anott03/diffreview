import { describe, expect, it } from "vitest";
import type { DiffFile } from "../shared/types";
import { buildFileTree, buildPathTree } from "./file-tree";

const file = (path: string, overrides: Partial<DiffFile> = {}): DiffFile => ({
  oldPath: path,
  newPath: path,
  status: "modified",
  isBinary: false,
  hunks: [],
  additions: 1,
  deletions: 0,
  ...overrides,
});

describe("buildFileTree", () => {
  it("builds comment-file trees without requiring live diff metadata", () => {
    const files = [
      { path: "archived/removed.ts", commentCount: 3 },
      { path: "README.md", commentCount: 1 },
      { path: "archived/other.ts", commentCount: 2 },
    ];
    expect(buildPathTree(files, (entry) => entry.path)).toEqual([
      {
        kind: "directory", name: "archived", path: "archived", children: [
          { kind: "file", name: "other.ts", path: "archived/other.ts", file: files[2] },
          { kind: "file", name: "removed.ts", path: "archived/removed.ts", file: files[0] },
        ],
      },
      { kind: "file", name: "README.md", path: "README.md", file: files[1] },
    ]);
  });

  it("groups shared directories and sorts folders first, then names naturally", () => {
    const inputs = [file("README.md"), file("src/z.ts"), file("src/ui/item10.ts"), file("src/ui/item2.ts"), file("src/a.ts")];
    const tree = buildFileTree(inputs);
    expect(tree).toMatchObject([
      {
        kind: "directory", name: "src", path: "src", children: [
          {
            kind: "directory", name: "ui", path: "src/ui", children: [
              { kind: "file", name: "item2.ts", path: "src/ui/item2.ts", file: inputs[3] },
              { kind: "file", name: "item10.ts", path: "src/ui/item10.ts", file: inputs[2] },
            ],
          },
          { kind: "file", name: "a.ts", path: "src/a.ts" },
          { kind: "file", name: "z.ts", path: "src/z.ts" },
        ],
      },
      { kind: "file", name: "README.md", path: "README.md" },
    ]);
    expect(buildFileTree([...inputs].reverse())).toEqual(tree);
  });

  it("uses the old path for deleted files and destination for renames", () => {
    const deleted = file("old/deleted.ts", { newPath: null, status: "deleted" });
    const renamed = file("old/name.ts", { newPath: "new/name.ts", status: "renamed" });
    expect(buildFileTree([deleted, renamed])).toMatchObject([
      { path: "new", children: [{ path: "new/name.ts", file: renamed }] },
      { path: "old", children: [{ path: "old/deleted.ts", file: deleted }] },
    ]);
  });

  it("keeps both entries when a deleted file is replaced by a directory", () => {
    const deleted = file("config", { newPath: null, status: "deleted" });
    const added = file("config/app.json", { oldPath: null, status: "added" });
    expect(buildFileTree([deleted, added])).toMatchObject([
      { kind: "directory", path: "config", children: [{ kind: "file", path: "config/app.json" }] },
      { kind: "file", path: "config", file: deleted },
    ]);
    expect(buildFileTree([])).toEqual([]);
  });
});

import { Collapsible } from "@cloudflare/kumo/components/collapsible";
import { Sidebar } from "@cloudflare/kumo/components/sidebar";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DiffFile } from "../core/diff-model";
import { DiffFileHeader } from "./DiffFileHeader";
import { FileList } from "./FileList";

const file: DiffFile = {
  oldPath: "src/old.ts", newPath: "src/new.ts", status: "renamed", isBinary: false,
  additions: 3, deletions: 2, hunks: [],
};

function renderHeader(input: DiffFile, collapsed: boolean) {
  return renderToStaticMarkup(createElement(
    Collapsible.Root,
    { open: !collapsed },
    createElement(DiffFileHeader, { file: input, collapsed }),
  ));
}

const fileListProps = {
  files: [{ path: "src/a.ts", change: { status: "modified", additions: 1, deletions: 4 } } as const, { path: "b.ts" }],
  selectedPath: "b.ts",
  onSelect: () => {},
  collapsedDirectories: new Set<string>(),
  onToggleDirectory: () => {},
};

function renderInSidebar(list: ReactElement) {
  return renderToStaticMarkup(createElement(Sidebar.Provider, null, list));
}

describe("DiffFileHeader", () => {
  it("shows the rename, status and line counts", () => {
    const html = renderHeader(file, false);
    expect(html).toContain("src/old.ts → src/new.ts");
    expect(html).toContain("renamed");
    expect(html).toContain("+3");
    expect(html).toContain("−2");
    expect(html).toContain('aria-label="Collapse diff"');
  });

  it("shows a single path unless the file was renamed", () => {
    const html = renderHeader({ ...file, status: "modified", oldPath: "src/new.ts" }, true);
    expect(html).not.toContain("→");
    expect(html).toContain("src/new.ts");
    expect(html).toContain('aria-label="Expand diff"');
  });
});

describe("FileList", () => {
  it("renders the tree with change counts and no badge by default", () => {
    const html = renderInSidebar(createElement(FileList, fileListProps));
    expect(html).toContain('aria-label="src"');
    expect(html).toContain('aria-label="src/a.ts (modified)"');
    expect(html).toContain('aria-current="true"');
    expect(html).toContain("+1");
    expect(html).not.toContain("comments");
  });

  it("asks the badge slot about each file by path", () => {
    const html = renderInSidebar(createElement(FileList, { ...fileListProps, renderFileBadge: (path) => `badge:${path}` }));
    expect(html).toContain("badge:src/a.ts");
    expect(html).toContain("badge:b.ts");
  });
});

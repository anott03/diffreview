import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Comment, DiffFile, FileContent } from "../shared/types";
import type { CommentDraft } from "./comment-draft";
import { DiffView } from "./components/DiffView";
import { FilePreview } from "./components/FilePreview";
import { SplitDiffTable, UnifiedDiffTable } from "./components/DiffTable";

const file: DiffFile = {
  oldPath: "file.txt", newPath: "file.txt", status: "modified", isBinary: false,
  additions: 1, deletions: 1,
  hunks: [{ header: "@@ -1,2 +1,2 @@", oldStart: 1, newStart: 1, lines: [
    { type: "context", oldLine: 1, newLine: 1, content: "unchanged" },
    { type: "del", oldLine: 2, content: "before" },
    { type: "add", newLine: 2, content: "after" },
  ] }],
};
const comment: Comment = {
  id: "old-comment", reviewId: "review", file: "file.txt", side: "old", line: 1,
  lineText: "unchanged", body: "Review the unchanged old side", author: "user", status: "open",
  createdAt: 0, updatedAt: 0,
};
const actions = {
  onResolve: () => {}, onReopen: () => {}, onDelete: () => {}, onCarryForward: () => {},
};
const loadFile = async (): Promise<FileContent> => ({ path: "file.txt", kind: "text", content: "unchanged\nafter\n" });

describe("comments and drafts outside changed lines", () => {
  it.each([UnifiedDiffTable, SplitDiffTable])("renders old-side context comments and a controlled draft in either layout", (Table) => {
    const html = renderToStaticMarkup(createElement(Table, {
      ...actions, file, commentsByAnchor: new Map([["old:1", [comment]]]),
      editing: { side: "old", line: 1, lineText: "unchanged", body: "Keep this draft" },
      onDraftBodyChange: () => {}, onStartComment: () => {}, onCancelComment: () => {},
      onSubmitComment: async () => {},
    }));
    expect(html).toContain("Review the unchanged old side");
    expect(html).toContain("Keep this draft");
    expect(html).toContain('aria-label="Add review comment"');
  });

  it.each(["new", "old"] as const)("retains %s-side draft text through preview, hidden context and visible diff renders", (side) => {
    const draft: CommentDraft = { side, line: 1, lineText: "unchanged", body: "Keep this draft across file changes" };
    const common = { ...actions, draft, onDraftChange: () => {}, comments: [], onSubmitComment: async () => {} };
    const preview = renderToStaticMarkup(createElement(FilePreview, {
      ...common, path: "file.txt", active: true, revision: 0, connectionVersion: 0, loadFile,
    }));
    const diffProps = {
      ...common, file, workspaceActive: true, revision: 1, connectionVersion: 0,
      loadContext: loadFile, reviewId: "review", collapsed: false, onToggleCollapse: () => {},
      layout: "unified" as const,
    };
    const hidden = renderToStaticMarkup(createElement(DiffView, { ...diffProps, file: { ...file, hunks: [] } }));
    const visible = renderToStaticMarkup(createElement(DiffView, diffProps));
    for (const html of [preview, hidden, visible]) {
      expect(html).toContain(draft.body);
    }
  });

  it("keeps comments on collapsed context accessible as saved threads", () => {
    const html = renderToStaticMarkup(createElement(DiffView, {
      ...actions, file, workspaceActive: true, revision: 0, connectionVersion: 0,
      loadContext: loadFile, reviewId: "review", layout: "unified", collapsed: false,
      onToggleCollapse: () => {}, onSubmitComment: async () => {}, draft: null, onDraftChange: () => {},
      comments: [{ ...comment, line: 20, body: "Hidden context comment" }],
    }));
    expect(html).toContain("Hidden context comment");
    expect(html).toContain("on hidden or outdated code");
    expect(html).toContain("unchanged lines");
  });
});

import { describe, expect, it } from "vitest";
import type { CreateCommentRequest } from "../shared/types";
import {
  commentDraftKey,
  retainedDraftEditingKey,
  submitCommentOnce,
  updateCommentDraft,
  type CommentDraft,
  type RetainedCommentDraft,
} from "./comment-draft";

const file = "file.txt";
const reviewId = "review";
const key = commentDraftKey(reviewId, file);
const draft: CommentDraft = { side: "new", line: 1, lineText: "code", body: "Review this" };
const request: CreateCommentRequest = { ...draft, file, reviewId };

function deferredSave() {
  let complete = () => {};
  const promise = new Promise<void>((resolve) => { complete = resolve; });
  return { promise, complete };
}

function initialDrafts() {
  return updateCommentDraft(new Map<string, RetainedCommentDraft>(), reviewId, file, draft);
}

describe("retained draft editor selection", () => {
  it("forgets a saved draft key before another draft is created on the same file", () => {
    let drafts = initialDrafts();
    let editingKey = retainedDraftEditingKey(key, drafts);
    expect(editingKey).toBe(key);

    drafts = updateCommentDraft(drafts, reviewId, file, null, draft);
    editingKey = retainedDraftEditingKey(editingKey, drafts);
    expect(editingKey).toBeNull();

    drafts = updateCommentDraft(drafts, reviewId, file, { ...draft, body: "Fresh draft" });
    expect(retainedDraftEditingKey(editingKey, drafts)).toBeNull();
  });

  it("forgets the removed key even when other drafts remain", () => {
    let drafts = initialDrafts();
    drafts = updateCommentDraft(drafts, reviewId, "another.txt", { ...draft });
    drafts = updateCommentDraft(drafts, reviewId, file, null, draft);
    expect(drafts.size).toBe(1);
    expect(retainedDraftEditingKey(key, drafts)).toBeNull();
  });

  it.each(["edited", "replaced"] as const)("keeps a %s recovery draft open when an older save completes", async (change) => {
    const pending = new Set<string>();
    const save = deferredSave();
    const result = submitCommentOnce(pending, request, () => save.promise, () => {});
    let drafts = initialDrafts();
    const newerDraft = { ...draft, body: "Newer draft" };
    if (change === "replaced") drafts = updateCommentDraft(drafts, reviewId, file, null, draft);
    drafts = updateCommentDraft(drafts, reviewId, file, newerDraft, change === "edited" ? draft : undefined);

    save.complete();
    expect(await result).toBe(true);
    expect(updateCommentDraft(drafts, reviewId, file, null, draft)).toBe(drafts);
    expect(drafts.get(key)?.draft).toBe(newerDraft);
    expect(retainedDraftEditingKey(key, drafts)).toBe(key);
  });

  it("does not overwrite an existing draft without its expected identity", () => {
    const drafts = initialDrafts();
    expect(updateCommentDraft(drafts, reviewId, file, { ...draft })).toBe(drafts);
    expect(updateCommentDraft(drafts, reviewId, file, null, { ...draft })).toBe(drafts);
  });
});

describe("comment submission guard", () => {
  it("returns not submitted for a duplicate and keeps the pending save and draft intact", async () => {
    const pending = new Set<string>();
    const save = deferredSave();
    let saves = 0;
    let notifications = 0;
    const create = async () => { saves += 1; await save.promise; };
    const notifyPending = () => { notifications += 1; };
    const first = submitCommentOnce(pending, request, create, notifyPending);
    let drafts = initialDrafts();
    const blocked = await submitCommentOnce(pending, request, create, notifyPending);
    if (blocked) drafts = updateCommentDraft(drafts, reviewId, file, null, draft);

    expect(blocked).toBe(false);
    expect(saves).toBe(1);
    expect(notifications).toBe(1);
    expect(pending.has(key)).toBe(true);
    expect(drafts.get(key)?.draft).toBe(draft);
    expect(retainedDraftEditingKey(key, drafts)).toBe(key);

    save.complete();
    expect(await first).toBe(true);
    expect(pending.size).toBe(0);
    expect(await submitCommentOnce(pending, request, create, notifyPending)).toBe(true);
    expect(saves).toBe(2);
    expect(notifications).toBe(1);
  });

  it("allows another file or review to save while the first request is pending", async () => {
    const pending = new Set<string>();
    const save = deferredSave();
    let notifications = 0;
    const notifyPending = () => { notifications += 1; };
    const first = submitCommentOnce(pending, request, () => save.promise, notifyPending);
    expect(await submitCommentOnce(pending, { ...request, file: "another.txt" }, async () => {}, notifyPending)).toBe(true);
    expect(await submitCommentOnce(pending, { ...request, reviewId: "next-review" }, async () => {}, notifyPending)).toBe(true);
    expect(pending.has(key)).toBe(true);
    expect(notifications).toBe(0);
    save.complete();
    expect(await first).toBe(true);
  });

  it("propagates actual save failures and releases the guard for a retry", async () => {
    const pending = new Set<string>();
    const failure = new Error("Server unavailable");
    let notifications = 0;
    const notifyPending = () => { notifications += 1; };
    await expect(submitCommentOnce(pending, request, async () => { throw failure; }, notifyPending)).rejects.toBe(failure);
    expect(pending.size).toBe(0);
    expect(notifications).toBe(0);
    expect(await submitCommentOnce(pending, request, async () => {}, notifyPending)).toBe(true);
  });
});

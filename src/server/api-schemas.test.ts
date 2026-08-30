import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import type {
  ApiErrorResponse,
  Comment,
  CreateCommentRequest,
  DiffFile,
  DiffHunk,
  DiffLine,
  GetDiffResponse,
  ListCommentsResponse,
  Meta,
  SseEvent,
  UpdateCommentRequest
} from "../shared/types";
import * as S from "./api-schemas";

// ---------------------------------------------------------------------------
// Type-level parity: each Schema's decoded type must be mutually assignable
// with the shared interface — shared-typed values (produced by the store,
// watcher, diff parser) must be encodable, and decoded values must be usable
// as the shared types. (Token-level `Equal` is too brittle across nested
// struct optionality representations; assignability is the contract that
// matters for the HTTP boundary.)
// ---------------------------------------------------------------------------

type Extends<A, B> = A extends B ? true : false;
type Expect<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B
  ? 1
  : 2
  ? true
  : false;
type MutuallyAssignable<A, B> = [Extends<A, B>, Extends<B, A>];
/** Strip readonly modifiers while preserving optionality (homomorphic). */
type Writable<T> = { -readonly [K in keyof T]: T[K] };

type SType<S extends { readonly Type: unknown }> = Writable<S["Type"]>;

export type _Parity = [
  Expect<Equal<Writable<typeof S.SideSchema["Type"]>, "old" | "new">>,
  Expect<Equal<Writable<typeof S.StatusSchema["Type"]>, "open" | "addressed">>,
  ...MutuallyAssignable<SType<typeof S.DiffLineSchema>, DiffLine>,
  ...MutuallyAssignable<SType<typeof S.DiffHunkSchema>, DiffHunk>,
  ...MutuallyAssignable<SType<typeof S.DiffFileSchema>, DiffFile>,
  ...MutuallyAssignable<SType<typeof S.CommentSchema>, Comment>,
  ...MutuallyAssignable<SType<typeof S.CreateCommentRequestSchema>, CreateCommentRequest>,
  ...MutuallyAssignable<SType<typeof S.UpdateCommentRequestSchema>, UpdateCommentRequest>,
  ...MutuallyAssignable<SType<typeof S.MetaSchema>, Meta>,
  ...MutuallyAssignable<SType<typeof S.GetDiffResponseSchema>, GetDiffResponse>,
  ...MutuallyAssignable<SType<typeof S.ListCommentsResponseSchema>, ListCommentsResponse>,
  ...MutuallyAssignable<SType<typeof S.ApiErrorResponseSchema>, ApiErrorResponse>,
  ...MutuallyAssignable<SType<typeof S.SseEventSchema>, SseEvent>
];

// ---------------------------------------------------------------------------
// Runtime behavior
// ---------------------------------------------------------------------------

const SAMPLE_COMMENT = {
  id: "c-1",
  file: "a.txt",
  side: "old",
  line: 2,
  lineText: "line2",
  body: "body",
  author: "user",
  status: "open",
  createdAt: 1700000000000,
  updatedAt: 1700000000000
} satisfies Comment;

describe("CommentSchema", () => {
  it("decodes a valid comment (note/outdated absent)", () => {
    const decoded = Schema.decodeUnknownSync(S.CommentSchema)(SAMPLE_COMMENT);
    expect("note" in decoded).toBe(false);
    expect(decoded.line).toBe(2);
  });

  it("decodes note present and outdated false (as resolveAnchors emits)", () => {
    const decoded = Schema.decodeUnknownSync(S.CommentSchema)({
      ...SAMPLE_COMMENT,
      note: "done",
      outdated: false
    });
    expect(decoded.note).toBe("done");
    expect(decoded.outdated).toBe(false);
  });

  it("round-trips comment → JSON without adding keys", () => {
    const encoded = Schema.encodeSync(S.CommentSchema)(
      Schema.decodeUnknownSync(S.CommentSchema)(SAMPLE_COMMENT)
    );
    const json = JSON.stringify(encoded);
    expect(json).not.toContain("note");
    expect(json).not.toContain("outdated");
    expect(JSON.parse(json)).toEqual(SAMPLE_COMMENT);
  });

  it("keeps present-but-false outdated in encoded JSON (Hono parity)", () => {
    const comment = { ...SAMPLE_COMMENT, outdated: false } as Comment;
    const json = JSON.stringify(Schema.encodeSync(S.CommentSchema)(comment));
    expect(json).toContain('"outdated":false');
  });

  it("rejects unknown enum values", () => {
    expect(() =>
      Schema.decodeUnknownSync(S.CommentSchema)({
        ...SAMPLE_COMMENT,
        side: "middle"
      })
    ).toThrow();
  });
});

describe("CreateCommentRequestSchema", () => {
  const VALID: CreateCommentRequest = {
    file: "a.txt",
    side: "new",
    line: 3,
    lineText: "",
    body: "hello"
  };

  it("accepts a valid payload", () => {
    expect(Schema.decodeUnknownSync(S.CreateCommentRequestSchema)(VALID)).toEqual(
      VALID
    );
  });

  it("rejects empty file / body (non-empty strings)", () => {
    for (const key of ["file", "body"]) {
      expect(() =>
        Schema.decodeUnknownSync(S.CreateCommentRequestSchema)({ ...VALID, [key]: "" })
      ).toThrow();
    }
  });

  it("rejects non-positive and non-integer lines", () => {
    for (const line of [0, -1, 1.5]) {
      expect(() =>
        Schema.decodeUnknownSync(S.CreateCommentRequestSchema)({ ...VALID, line })
      ).toThrow();
    }
  });

  it("rejects missing fields", () => {
    expect(() => Schema.decodeUnknownSync(S.CreateCommentRequestSchema)({})).toThrow();
  });
});

describe("UpdateCommentRequestSchema", () => {
  it("accepts single-field patches", () => {
    expect(
      Schema.decodeUnknownSync(S.UpdateCommentRequestSchema)({ status: "addressed" })
    ).toEqual({ status: "addressed" });
    expect(
      Schema.decodeUnknownSync(S.UpdateCommentRequestSchema)({ note: "done" })
    ).toEqual({ note: "done" });
  });

  it("accepts combined patches", () => {
    expect(
      Schema.decodeUnknownSync(S.UpdateCommentRequestSchema)({
        status: "addressed",
        note: "n",
        body: "b"
      })
    ).toEqual({ status: "addressed", note: "n", body: "b" });
  });

  it("rejects empty patches (the zod 'empty patch' refinement)", () => {
    expect(() => Schema.decodeUnknownSync(S.UpdateCommentRequestSchema)({})).toThrow();
  });

  it("rejects invalid enum values", () => {
    expect(() =>
      Schema.decodeUnknownSync(S.UpdateCommentRequestSchema)({ status: "resolved" })
    ).toThrow();
  });
});

describe("response schemas", () => {
  it("MetaSchema matches meta shape", () => {
    const meta: Meta = {
      repoRoot: "/r",
      branch: "main",
      head: "sha",
      files: 1,
      additions: 2,
      deletions: 3
    };
    expect(Schema.decodeUnknownSync(S.MetaSchema)(meta)).toEqual(meta);
  });

  it("ListCommentsResponseSchema validates comment lists", () => {
    const res: ListCommentsResponse = { comments: [SAMPLE_COMMENT] };
    expect(Schema.decodeUnknownSync(S.ListCommentsResponseSchema)(res)).toEqual(res);
  });

  it("GetDiffResponseSchema validates file lists", () => {
    const file: DiffFile = {
      oldPath: "a.txt",
      newPath: "a.txt",
      status: "modified",
      isBinary: false,
      hunks: [
        {
          header: "@@ -1,2 +1,2 @@",
          oldStart: 1,
          newStart: 1,
          lines: [{ type: "context", oldLine: 1, newLine: 1, content: "x" }]
        }
      ],
      additions: 1,
      deletions: 0
    };
    const res: GetDiffResponse = { files: [file] };
    expect(Schema.decodeUnknownSync(S.GetDiffResponseSchema)(res)).toEqual(res);
  });

  it("SseEventSchema validates event frames", () => {
    const ev: SseEvent = { type: "diff", at: 1700000000000 };
    expect(Schema.decodeUnknownSync(S.SseEventSchema)(ev)).toEqual(ev);
  });
});

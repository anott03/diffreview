import { z } from "zod";
import type {
  ApiErrorResponse,
  Comment,
  DiffFile,
  GetDiffResponse,
  ListCommentsResponse,
  Meta,
} from "./types";

const DiffFileSchema = z.object({
  oldPath: z.string().nullable(),
  newPath: z.string().nullable(),
  status: z.enum(["added", "modified", "deleted", "renamed"]),
  isBinary: z.boolean(),
  hunks: z.array(z.object({
    header: z.string(),
    oldStart: z.number(),
    newStart: z.number(),
    lines: z.array(z.object({
      type: z.enum(["add", "del", "context"]),
      oldLine: z.number().optional(),
      newLine: z.number().optional(),
      content: z.string(),
    })),
  })),
  additions: z.number(),
  deletions: z.number(),
}) satisfies z.ZodType<DiffFile>;

export const CommentSchema = z.object({
  id: z.string(),
  reviewId: z.string().optional(),
  reviewHead: z.string().optional(),
  historical: z.boolean().optional(),
  file: z.string(),
  side: z.enum(["old", "new"]),
  line: z.number(),
  lineText: z.string(),
  context: z.object({
    source: z.enum(["snapshot", "head"]),
    line: z.number(),
    lines: z.array(z.object({ line: z.number(), content: z.string() })),
  }).optional(),
  body: z.string(),
  author: z.enum(["user", "agent"]),
  status: z.enum(["open", "addressed"]),
  note: z.string().optional(),
  outdated: z.boolean().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
}) satisfies z.ZodType<Comment>;

export const MetaSchema = z.object({
  repoRoot: z.string(),
  branch: z.string(),
  head: z.string(),
  files: z.number(),
  additions: z.number(),
  deletions: z.number(),
}) satisfies z.ZodType<Meta>;

export const GetDiffResponseSchema = z.object({
  files: z.array(DiffFileSchema),
  reviewId: z.string(),
}) satisfies z.ZodType<GetDiffResponse>;

export const ListCommentsResponseSchema = z.object({
  comments: z.array(CommentSchema),
}) satisfies z.ZodType<ListCommentsResponse>;

export const ApiErrorResponseSchema = z.object({
  error: z.string(),
}) satisfies z.ZodType<ApiErrorResponse>;

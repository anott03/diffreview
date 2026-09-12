import { useEffect, useRef } from "react";
import { z } from "zod";
import type { CreateCommentRequest, UpdateCommentRequest } from "../shared/types";
import {
  ApiErrorResponseSchema,
  CommentSchema,
  GetDiffResponseSchema,
  ListCommentsResponseSchema,
  MetaSchema,
} from "../shared/response-schemas";

async function request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = ApiErrorResponseSchema.parse(await res.json());
      if (body.error) message = body.error;
    } catch {
      // keep the status-based message
    }
    throw new Error(message);
  }
  return schema.parse(res.status === 204 ? undefined : await res.json());
}

const json = (body: CreateCommentRequest | UpdateCommentRequest) => ({
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const api = {
  getMeta: () => request("/api/meta", MetaSchema),
  getDiff: () => request("/api/diff", GetDiffResponseSchema),
  getComments: () => request("/api/comments?status=all", ListCommentsResponseSchema),
  createComment: (input: CreateCommentRequest) =>
    request("/api/comments", CommentSchema, { method: "POST", ...json(input) }),
  updateComment: (id: string, patch: UpdateCommentRequest) =>
    request(`/api/comments/${id}`, CommentSchema, { method: "PATCH", ...json(patch) }),
  deleteComment: (id: string) => request(`/api/comments/${id}`, z.void(), { method: "DELETE" }),
};

/**
 * Subscribes to the server's SSE channel. Events are invalidation signals —
 * handlers should refetch the corresponding resource.
 */
export function useServerEvents(handlers: { onDiff: () => void; onComments: () => void }) {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    const source = new EventSource("/api/events");
    source.addEventListener("diff", () => ref.current.onDiff());
    source.addEventListener("comments", () => ref.current.onComments());
    return () => source.close();
  }, []);
}

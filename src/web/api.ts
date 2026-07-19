import { useEffect, useRef } from "react";
import type {
  ApiErrorResponse,
  Comment,
  CreateCommentRequest,
  GetDiffResponse,
  ListCommentsResponse,
  Meta,
  UpdateCommentRequest,
} from "../shared/types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as ApiErrorResponse;
      if (body.error) message = body.error;
    } catch {
      // keep the status-based message
    }
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const json = (body: unknown) => ({
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const api = {
  getMeta: () => request<Meta>("/api/meta"),
  getDiff: () => request<GetDiffResponse>("/api/diff"),
  getComments: () => request<ListCommentsResponse>("/api/comments?status=all"),
  createComment: (input: CreateCommentRequest) =>
    request<Comment>("/api/comments", { method: "POST", ...json(input) }),
  updateComment: (id: string, patch: UpdateCommentRequest) =>
    request<Comment>(`/api/comments/${id}`, { method: "PATCH", ...json(patch) }),
  deleteComment: (id: string) => request<void>(`/api/comments/${id}`, { method: "DELETE" }),
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

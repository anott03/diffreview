import { useEffect, useRef } from "react";
import { z } from "zod";
import type { CreateCommentRequest, UpdateCommentRequest } from "../shared/types";
import {
  ApiErrorResponseSchema,
  CommentSchema,
  GetDiffResponseSchema,
  ListFilesResponseSchema,
  FileContentSchema,
  ListCommentsResponseSchema,
  MetaSchema,
  ProjectSchema,
  ListProjectsResponseSchema,
  ServerInfoSchema,
  SseEventSchema,
} from "../shared/response-schemas";

async function request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = ApiErrorResponseSchema.parse(await res.json());
      if (body.error) message = body.error;
    } catch {
      // Non-JSON errors still carry the HTTP status.
    }
    throw new Error(message);
  }
  return schema.parse(res.status === 204 ? undefined : await res.json());
}

const json = (body: CreateCommentRequest | UpdateCommentRequest | { path: string }) => ({
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const globalApi = {
  getServer: (signal?: AbortSignal) => request("/api/server", ServerInfoSchema, { signal }),
  getProjects: (signal?: AbortSignal) => request("/api/projects", ListProjectsResponseSchema, { signal }),
  openProject: (path: string) => request("/api/projects", ProjectSchema, { method: "POST", ...json({ path }) }),
};

export function createProjectApi(projectId: string) {
  const base = `/api/projects/${encodeURIComponent(projectId)}`;
  return {
    getMeta: (signal?: AbortSignal) => request(`${base}/meta`, MetaSchema, { signal }),
    getDiff: (signal?: AbortSignal) => request(`${base}/diff`, GetDiffResponseSchema, { signal }),
    getFiles: (signal?: AbortSignal) => request(`${base}/files`, ListFilesResponseSchema, { signal }),
    getFile: (path: string, signal?: AbortSignal) =>
      request(`${base}/file?${new URLSearchParams({ path })}`, FileContentSchema, { signal }),
    getFileContext: (path: string, reviewId: string, signal?: AbortSignal) =>
      request(`${base}/file?${new URLSearchParams({ path, context: "true", reviewId })}`, FileContentSchema, { signal }),
    getComments: (signal?: AbortSignal) => request(`${base}/comments?status=all`, ListCommentsResponseSchema, { signal }),
    createComment: (input: CreateCommentRequest) =>
      request(`${base}/comments`, CommentSchema, { method: "POST", ...json(input) }),
    updateComment: (id: string, patch: UpdateCommentRequest) =>
      request(`${base}/comments/${encodeURIComponent(id)}`, CommentSchema, { method: "PATCH", ...json(patch) }),
    deleteComment: (id: string) => request(`${base}/comments/${encodeURIComponent(id)}`, z.void(), { method: "DELETE" }),
  };
}

interface ServerEventHandlers {
  onProject: (projectId: string) => void;
  onProjects: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
}

export function subscribeServerEvents(handlers: ServerEventHandlers): () => void {
  const source = new EventSource("/api/events");
  const invalidate = (event: MessageEvent<string>) => {
    try {
      const parsed = SseEventSchema.safeParse(JSON.parse(event.data));
      if (!parsed.success) return;
      if (parsed.data.type === "projects") handlers.onProjects();
      else handlers.onProject(parsed.data.projectId);
    } catch {
      // A malformed event must not disconnect the remaining projects.
    }
  };
  source.addEventListener("diff", invalidate);
  source.addEventListener("comments", invalidate);
  source.addEventListener("projects", invalidate);
  source.addEventListener("open", handlers.onConnect);
  source.addEventListener("error", handlers.onDisconnect);
  return () => source.close();
}

export function useServerEvents(handlers: ServerEventHandlers) {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => subscribeServerEvents({
    onProject: (id) => ref.current.onProject(id),
    onProjects: () => ref.current.onProjects(),
    onConnect: () => ref.current.onConnect(),
    onDisconnect: () => ref.current.onDisconnect(),
  }), []);
}

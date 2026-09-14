import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Loader } from "@cloudflare/kumo/components/loader";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Comment, CommentStatus, CreateCommentRequest, DiffFile, Meta } from "../shared/types";
import { diffFilePath } from "../shared/types";
import { createProjectApi } from "./api";
import { DiffView, type Layout } from "./components/DiffView";
import { EmptyState } from "./components/EmptyState";
import { FileList } from "./components/FileList";
import { CommentList } from "./components/CommentList";
import type { CommentGrouping, CommentSort } from "./comment-groups";

interface ProjectWorkspaceProps {
  projectId: string;
  active: boolean;
  revision: number;
  connectionVersion: number;
}

export function ProjectWorkspace({ projectId, active, revision, connectionVersion }: ProjectWorkspaceProps) {
  const api = useMemo(() => createProjectApi(projectId), [projectId]);
  const toasts = useKumoToastManager();
  const toastsRef = useRef(toasts);
  toastsRef.current = toasts;
  const activeRef = useRef(active);
  activeRef.current = active;
  const mounted = useRef(false);
  const pendingRead = useRef<AbortController | null>(null);
  const prevComments = useRef<Comment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const notify = useCallback((...args: Parameters<typeof toasts.add>) => {
    if (mounted.current && activeRef.current) toastsRef.current.add(...args);
  }, []);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [files, setFiles] = useState<DiffFile[] | null>(null);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [layout, setLayout] = useState<Layout>("unified");
  const [view, setView] = useState<"changes" | "comments">("changes");
  const [commentStatus, setCommentStatus] = useState<CommentStatus | "all">("open");
  const [commentSort, setCommentSort] = useState<CommentSort>("newest");
  const [commentGrouping, setCommentGrouping] = useState<CommentGrouping>("list");
  const [collapsedCommentPaths, setCollapsedCommentPaths] = useState<Set<string>>(new Set());
  const [selectedCommentPath, setSelectedCommentPath] = useState<string | null>(null);
  const [collapsedCommentDirectories, setCollapsedCommentDirectories] = useState<Set<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(new Set());
  const [collapsedDirectories, setCollapsedDirectories] = useState<Set<string>>(new Set());
  const fileRefs = useRef<Record<string, HTMLDivElement | null>>({});

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pendingRead.current?.abort();
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!activeRef.current || !mounted.current) return;
    pendingRead.current?.abort();
    const controller = new AbortController();
    pendingRead.current = controller;
    try {
      const [nextMeta, diff, result] = await Promise.all([
        api.getMeta(controller.signal),
        api.getDiff(controller.signal),
        api.getComments(controller.signal),
      ]);
      if (controller.signal.aborted || !mounted.current || !activeRef.current) return;
      const prev = prevComments.current;
      const addressed = result.comments.filter((comment) => comment.status === "addressed"
        && prev?.some((previous) => previous.id === comment.id && previous.status === "open"));
      if (addressed.length > 0) {
        notify({ variant: "success", title: `${addressed.length} comment${addressed.length === 1 ? "" : "s"} marked addressed` });
      }
      prevComments.current = result.comments;
      setMeta(nextMeta);
      setFiles(diff.files);
      setReviewId(diff.reviewId);
      setComments(result.comments);
      setError(null);
    } catch (err) {
      if (!controller.signal.aborted && mounted.current && activeRef.current) setError(String(err));
    }
  }, [api, notify]);

  useEffect(() => {
    if (!active) {
      prevComments.current = null;
      return;
    }
    void refresh();
    return () => pendingRead.current?.abort();
  }, [active, revision, connectionVersion, refresh]);

  const submitComment = async (input: CreateCommentRequest) => {
    try {
      const request = { ...input };
      if (reviewId) request.reviewId = reviewId;
      await api.createComment(request);
      await refresh();
    } catch (err) {
      notify({ variant: "error", title: "Failed to save comment", description: String(err) });
      throw err;
    }
  };

  const resolveComment = (id: string) => {
    api
      .updateComment(id, { status: "addressed" })
      .then(refresh)
      .catch((err) => notify({ variant: "error", title: "Failed to resolve", description: String(err) }));
  };

  const carryForwardComment = (id: string) => {
    api
      .updateComment(id, { carryForward: true })
      .then(async () => {
        await refresh();
        notify({ variant: "success", title: "Comment carried forward to the current review" });
      })
      .catch((err) => notify({ variant: "error", title: "Failed to carry forward", description: String(err) }));
  };

  const reopenComment = (id: string) => {
    api
      .updateComment(id, { status: "open" })
      .then(refresh)
      .catch((err) => notify({ variant: "error", title: "Failed to reopen", description: String(err) }));
  };

  const deleteComment = (id: string) => {
    api
      .deleteComment(id)
      .then(refresh)
      .catch((err) => notify({ variant: "error", title: "Failed to delete", description: String(err) }));
  };

  const selectFile = useCallback((path: string) => {
    setSelectedPath(path);
    setCollapsedPaths((prev) => {
      if (!prev.has(path)) return prev;
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
  }, []);

  const toggleCollapsed = useCallback((path: string) => {
    setCollapsedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const toggleCommentCollapsed = useCallback((path: string) => {
    setCollapsedCommentPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const selectCommentFile = useCallback((path: string) => {
    setSelectedCommentPath(path);
    setCollapsedCommentPaths((prev) => {
      if (!prev.has(path)) return prev;
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
  }, []);

  const toggleCommentDirectory = useCallback((path: string) => {
    setCollapsedCommentDirectories((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const toggleDirectory = useCallback((path: string) => {
    setCollapsedDirectories((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!selectedPath) return;
    const el = fileRefs.current[selectedPath];
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [selectedPath, view]);

  const openCount = comments.filter((c) => c.status === "open").length;
  const reviewComments = comments.filter((c) => c.reviewId === reviewId && !c.historical);

  if (files === null) {
    return (
      <div className="grid h-full place-items-center px-4 py-6">
        {error ? (
          <div className="max-w-xl space-y-3 text-sm">
            <h1 className="text-lg font-semibold">Project unavailable</h1>
            <p role="alert" className="break-words text-kumo-subtle">{error}</p>
            <p>Check that the working tree still exists on the server. Other project tabs remain available.</p>
            <Button variant="secondary" onClick={() => void refresh()}>Retry</Button>
          </div>
        ) : <div role="status" className="flex items-center gap-2 text-sm"><Loader />Loading project…</div>}
      </div>
    );
  }

  const allCollapsed = files.length > 0 && files.every((file) => collapsedPaths.has(diffFilePath(file)));

  return (
    <div className="flex h-full flex-col">
      {error && (
        <div role="alert" className="flex flex-wrap items-center gap-3 border-b border-kumo-line bg-kumo-warning-tint px-4 py-2 text-sm">
          <span className="min-w-0 flex-1 break-words">Could not refresh this project. {error}</span>
          <Button variant="secondary" size="sm" onClick={() => void refresh()}>Retry</Button>
        </div>
      )}
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-kumo-line bg-kumo-elevated px-4 py-2">
        <Tabs
          size="sm"
          tabs={[
            { value: "changes", label: "Changes" },
            { value: "comments", label: `Comments (${openCount} open)` },
          ]}
          value={view}
          onValueChange={(value) => {
            if (value === "changes" || value === "comments") setView(value);
          }}
        />
        {meta && (
          <>
            <span className="hidden max-w-64 truncate font-mono text-xs text-kumo-subtle xl:inline" title={meta.repoRoot}>{meta.repoRoot}</span>
            <Badge variant="outline">{meta.branch}</Badge>
            <span className="font-mono text-xs">
              <span className="text-kumo-success">+{meta.additions}</span>{" "}
              <span className="text-kumo-danger">−{meta.deletions}</span>
            </span>
          </>
        )}
        <span className="flex-1" />
        {openCount > 0 && <Badge variant="warning">{openCount} open</Badge>}
        {view === "changes" && (
          <Button
            variant="secondary"
            size="sm"
            disabled={files.length === 0}
            onClick={() => setCollapsedPaths(allCollapsed ? new Set() : new Set(files.map(diffFilePath)))}
          >
            {allCollapsed ? "Expand all" : "Collapse all"}
          </Button>
        )}
        {view === "changes" && (
          <Tabs
            size="sm"
            tabs={[
              { value: "unified", label: "Unified" },
              { value: "split", label: "Split" },
            ]}
            value={layout}
            onValueChange={(value) => {
              if (value === "unified" || value === "split") setLayout(value);
            }}
          />
        )}
      </header>

      <div className="relative flex min-h-0 flex-1">
        {view === "comments" ? (
          <CommentList
            comments={comments}
            status={commentStatus}
            sort={commentSort}
            grouping={commentGrouping}
            onGroupingChange={setCommentGrouping}
            onSortChange={setCommentSort}
            collapsedPaths={collapsedCommentPaths}
            onToggleCollapse={toggleCommentCollapsed}
            onStatusChange={setCommentStatus}
            onCarryForward={carryForwardComment}
            onResolve={resolveComment}
            onReopen={reopenComment}
            onDelete={deleteComment}
            selectedPath={selectedCommentPath}
            onSelectFile={selectCommentFile}
            collapsedDirectories={collapsedCommentDirectories}
            onToggleDirectory={toggleCommentDirectory}
          />
        ) : files.length === 0 ? (
          <div className="flex-1">
            <EmptyState>
              {openCount > 0 && (
                <Button variant="secondary" onClick={() => {
                  setCommentStatus("open");
                  setView("comments");
                }}>
                  View {openCount} open comment{openCount === 1 ? "" : "s"}
                </Button>
              )}
            </EmptyState>
          </div>
        ) : (
          <>
            <FileList
              files={files.map((file) => ({
                path: diffFilePath(file),
                change: file,
                commentCount: reviewComments.filter((comment) => comment.file === diffFilePath(file) && comment.status === "open").length,
              }))}
              selectedPath={selectedPath}
              onSelect={selectFile}
              collapsedDirectories={collapsedDirectories}
              onToggleDirectory={toggleDirectory}
            />
            <main className="min-w-0 flex-1 overflow-y-auto [overflow-anchor:none]">
              {files.map((file) => {
                const path = diffFilePath(file);
                return (
                  <div
                    key={`${reviewId}:${path}`}
                    id={`${projectId}:${path}`}
                    ref={(el) => {
                      fileRefs.current[path] = el;
                    }}
                  >
                    <DiffView
                      file={file}
                      layout={layout}
                      comments={reviewComments.filter((c) => c.file === path)}
                      collapsed={collapsedPaths.has(path)}
                      onToggleCollapse={() => toggleCollapsed(path)}
                      onSubmitComment={submitComment}
                      onResolve={resolveComment}
                      onReopen={reopenComment}
                      onDelete={deleteComment}
                    />
                  </div>
                );
              })}
            </main>
          </>
        )}
      </div>
    </div>
  );
}

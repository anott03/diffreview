import { Button } from "@cloudflare/kumo/components/button";
import { Loader } from "@cloudflare/kumo/components/loader";
import { Select } from "@cloudflare/kumo/components/select";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Comment, CommentStatus, CreateCommentRequest, DiffFile } from "../shared/types";
import { diffFilePath } from "../shared/types";
import { createProjectApi } from "./api";
import { CommitHistory } from "./components/CommitHistory";
import { DiffView, type Layout } from "./components/DiffView";
import { EmptyState } from "./components/EmptyState";
import { FileList } from "./components/FileList";
import { FilePreview } from "./components/FilePreview";
import { filterComments } from "./comment-filter";
import type { CommentDraft } from "./comment-draft";

interface ProjectWorkspaceProps {
  projectId: string;
  active: boolean;
  revision: number;
  connectionVersion: number;
  toolbarContainer: HTMLDivElement | null;
}

export function ProjectWorkspace({ projectId, active, revision, connectionVersion, toolbarContainer }: ProjectWorkspaceProps) {
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
  const [files, setFiles] = useState<DiffFile[] | null>(null);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [drafts, setDrafts] = useState<Map<string, CommentDraft>>(new Map());
  const changeDraft = (key: string, draft: CommentDraft | null) => {
    setDrafts((previous) => {
      const next = new Map(previous);
      if (draft) next.set(key, draft);
      else next.delete(key);
      return next;
    });
  };
  const [layout, setLayout] = useState<Layout>("unified");
  const [commentStatus, setCommentStatus] = useState<CommentStatus | "all">("open");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileMode, setFileMode] = useState<"changed" | "all" | "history">("changed");
  const [projectPaths, setProjectPaths] = useState<string[] | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [treeRetry, setTreeRetry] = useState(0);
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
      const [diff, result] = await Promise.all([
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

  useEffect(() => {
    if (!active || fileMode !== "all") return;
    const controller = new AbortController();
    setTreeError(null);
    void api.getFiles(controller.signal).then((result) => {
      if (!controller.signal.aborted) setProjectPaths(result.files);
    }).catch((cause) => {
      if (!controller.signal.aborted) setTreeError(String(cause));
    });
    return () => controller.abort();
  }, [api, active, fileMode, revision, connectionVersion, treeRetry]);

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
  }, [selectedPath, fileMode]);

  const visibleComments = filterComments(comments, reviewId, fileMode, commentStatus);

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
  const changesByPath = new Map(files.map((file) => [diffFilePath(file), file]));
  const commentCounts = new Map<string, number>();
  for (const comment of visibleComments) {
    commentCounts.set(comment.file, (commentCounts.get(comment.file) ?? 0) + 1);
  }
  const historyMode = fileMode === "history";
  const sidebarPaths = fileMode === "all" ? projectPaths ?? [] : files.map(diffFilePath);
  const sidebarTitle = fileMode === "all" ? "All files" : historyMode ? "Commits" : "Changed files";
  const previewPath = fileMode === "all" && selectedPath && !changesByPath.has(selectedPath) ? selectedPath : null;
  const fileModeSelect = (
    <Select
      size="sm"
      className="w-full min-w-0 text-sm"
      aria-label="Sidebar view"
      value={fileMode}
      items={{ changed: "Changed files", all: "All files", history: "Commits" }}
      onValueChange={(value) => {
        if (value === "changed" || value === "all" || value === "history") setFileMode(value);
      }}
    />
  );

  return (
    <div className="flex h-full flex-col">
      {error && (
        <div role="alert" className="flex flex-wrap items-center gap-3 border-b border-kumo-line bg-kumo-warning-tint px-4 py-2 text-sm">
          <span className="min-w-0 flex-1 break-words">Could not refresh this project. {error}</span>
          <Button variant="secondary" size="sm" onClick={() => void refresh()}>Retry</Button>
        </div>
      )}
      {active && !previewPath && toolbarContainer && createPortal(
        <div role="group" aria-label="Diff controls" className="flex shrink-0 items-center gap-3">
          {!historyMode && (
            <Button
              variant="secondary"
              size="sm"
              disabled={files.length === 0}
              onClick={() => setCollapsedPaths(allCollapsed ? new Set() : new Set(files.map(diffFilePath)))}
            >
              {allCollapsed ? "Expand all" : "Collapse all"}
            </Button>
          )}
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
        </div>,
        toolbarContainer
      )}

      <div className="relative flex min-h-0 flex-1">
        {historyMode ? (
          <CommitHistory
            key={`${revision}:${connectionVersion}`}
            api={api}
            active={active}
            layout={layout}
            header={fileModeSelect}
          />
        ) : (
          <>
            <FileList
              title={sidebarTitle}
              commentLabel={commentStatus === "all" ? "comments" : `${commentStatus} comments`}
              header={(
                <div className="grid grid-cols-2 gap-2 [&>div]:min-w-0">
                  {fileModeSelect}
                  <Select
                    size="sm"
                    className="w-full min-w-0 text-sm"
                    aria-label="Comment status"
                    value={commentStatus}
                    items={{ open: "Open", addressed: "Addressed", all: "All" }}
                    onValueChange={(value) => {
                      if (value === "open" || value === "addressed" || value === "all") setCommentStatus(value);
                    }}
                  />
                </div>
              )}
              notice={fileMode === "all" && (
                treeError ? (
                  <div role="alert" className="space-y-2 px-3 py-2 text-sm">
                    <p className="break-words">Could not load files. {treeError}</p>
                    <Button variant="secondary" size="sm" onClick={() => setTreeRetry((value) => value + 1)}>Retry</Button>
                  </div>
                ) : projectPaths === null ? (
                  <div role="status" className="flex items-center gap-2 px-3 py-2 text-sm"><Loader />Loading files…</div>
                ) : projectPaths.length === 0 ? (
                  <p className="px-3 py-2 text-sm text-kumo-subtle">No project files.</p>
                ) : null
              )}
              files={sidebarPaths.map((path) => {
                const entry = { path, commentCount: commentCounts.get(path) ?? 0 };
                const change = changesByPath.get(path);
                return change ? { ...entry, change } : entry;
              })}
              selectedPath={selectedPath}
              onSelect={selectFile}
              collapsedDirectories={collapsedDirectories}
              onToggleDirectory={toggleDirectory}
            />
            {previewPath && (
              <FilePreview
                key={`${reviewId}:${previewPath}`}
                path={previewPath}
                draft={drafts.get(`${reviewId}:${previewPath}`) ?? null}
                onDraftChange={(draft) => changeDraft(`${reviewId}:${previewPath}`, draft)}
                active={active}
                revision={revision}
                connectionVersion={connectionVersion}
                loadFile={api.getFile}
                comments={visibleComments.filter((comment) => comment.file === previewPath)}
                onSubmitComment={submitComment}
                onCarryForward={carryForwardComment}
                onResolve={resolveComment}
                onReopen={reopenComment}
                onDelete={deleteComment}
              />
            )}
            <main hidden={previewPath !== null} className="min-w-0 flex-1 overflow-y-auto [overflow-anchor:none]">
              {files.length === 0 && (
                fileMode === "all" ? (
                  <p className="px-4 py-6 text-sm text-kumo-subtle">Select a file to preview its contents.</p>
                ) : (
                  <EmptyState />
                )
              )}
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
                      workspaceActive={active && previewPath === null}
                      revision={revision}
                      connectionVersion={connectionVersion}
                      loadContext={api.getFileContext}
                      reviewId={reviewId ?? ""}
                      draft={drafts.get(`${reviewId}:${path}`) ?? null}
                      onDraftChange={(draft) => changeDraft(`${reviewId}:${path}`, draft)}
                      layout={layout}
                      comments={visibleComments.filter((c) => c.file === path)}
                      onCarryForward={carryForwardComment}
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

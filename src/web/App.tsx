import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Loader } from "@cloudflare/kumo/components/loader";
import { Sidebar } from "@cloudflare/kumo/components/sidebar";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Comment, CommentStatus, CreateCommentRequest, DiffFile, Meta } from "../shared/types";
import { diffFilePath } from "../shared/types";
import { api, useServerEvents } from "./api";
import { DiffView, type Layout } from "./components/DiffView";
import { EmptyState } from "./components/EmptyState";
import { FileList } from "./components/FileList";
import { ThemeToggle } from "./components/ThemeToggle";
import { CommentList } from "./components/CommentList";
import type { CommentGrouping, CommentSort } from "./comment-groups";

const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 600;
const SIDEBAR_DEFAULT_WIDTH = 260;

export function App() {
  const toasts = useKumoToastManager();
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
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const saved = localStorage.getItem("diffreview-sidebar-width");
      const width = saved === null ? SIDEBAR_DEFAULT_WIDTH : Number(saved);
      return Number.isFinite(width)
        ? Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width))
        : SIDEBAR_DEFAULT_WIDTH;
    } catch {
      return SIDEBAR_DEFAULT_WIDTH;
    }
  });
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try {
      return localStorage.getItem("diffreview-sidebar") !== "false";
    } catch {
      return true;
    }
  });
  const fileRefs = useRef<Record<string, HTMLDivElement | null>>({});

  useEffect(() => {
    try {
      localStorage.setItem("diffreview-sidebar", String(sidebarOpen));
    } catch {
      // Storage may be disabled in some contexts — ignore.
    }
  }, [sidebarOpen]);

  useEffect(() => {
    try {
      localStorage.setItem("diffreview-sidebar-width", String(sidebarWidth));
    } catch {
      // Storage may be disabled in some contexts — ignore.
    }
  }, [sidebarWidth]);

  const refreshDiff = useCallback(async () => {
    try {
      const [meta, diff] = await Promise.all([api.getMeta(), api.getDiff()]);
      setMeta(meta);
      setFiles(diff.files);
      setReviewId(diff.reviewId);
    } catch {
      // Transient failure (server restarting) — the next SSE event retries.
    }
  }, []);

  const refreshComments = useCallback(async () => {
    try {
      const res = await api.getComments();
      setComments(res.comments);
    } catch {
      // Same as above.
    }
  }, []);

  useEffect(() => {
    void refreshDiff();
    void refreshComments();
  }, [refreshDiff, refreshComments]);

  useServerEvents({
    onDiff: () => {
      void refreshDiff();
      void refreshComments();
    },
    onComments: () => void refreshComments(),
  });

  // Toast on open → addressed transitions from either the UI or an agent.
  const prevComments = useRef<Comment[]>([]);
  useEffect(() => {
    const prev = prevComments.current;
    const newlyAddressed = comments.filter(
      (c) => c.status === "addressed" && prev.some((p) => p.id === c.id && p.status === "open"),
    );
    if (newlyAddressed.length > 0) {
      toasts.add({
        variant: "success",
        title: `${newlyAddressed.length} comment${newlyAddressed.length === 1 ? "" : "s"} marked addressed`,
      });
    }
    prevComments.current = comments;
  }, [comments, toasts]);

  const submitComment = async (input: CreateCommentRequest) => {
    try {
      await api.createComment({ ...input, ...(reviewId ? { reviewId } : {}) });
      await refreshComments();
    } catch (err) {
      toasts.add({ variant: "error", title: "Failed to save comment", description: String(err) });
      throw err;
    }
  };

  const resolveComment = (id: string) => {
    api
      .updateComment(id, { status: "addressed" })
      .then(refreshComments)
      .catch((err) => toasts.add({ variant: "error", title: "Failed to resolve", description: String(err) }));
  };

  const carryForwardComment = (id: string) => {
    api
      .updateComment(id, { carryForward: true })
      .then(async () => {
        await Promise.all([refreshDiff(), refreshComments()]);
        toasts.add({ variant: "success", title: "Comment carried forward to the current review" });
      })
      .catch((err) => toasts.add({ variant: "error", title: "Failed to carry forward", description: String(err) }));
  };

  const reopenComment = (id: string) => {
    api
      .updateComment(id, { status: "open" })
      .then(refreshComments)
      .catch((err) => toasts.add({ variant: "error", title: "Failed to reopen", description: String(err) }));
  };

  const deleteComment = (id: string) => {
    api
      .deleteComment(id)
      .then(refreshComments)
      .catch((err) => toasts.add({ variant: "error", title: "Failed to delete", description: String(err) }));
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
      <div className="grid h-full place-items-center">
        <Loader />
      </div>
    );
  }

  const allCollapsed = files.length > 0 && files.every((file) => collapsedPaths.has(diffFilePath(file)));

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-kumo-line bg-kumo-elevated px-4 py-2">
        <span className="text-sm font-semibold">diffreview</span>
        <Tabs
          size="sm"
          tabs={[
            { value: "changes", label: "Changes" },
            { value: "comments", label: `Comments (${openCount} open)` },
          ]}
          value={view}
          onValueChange={(value) => setView(value as "changes" | "comments")}
        />
        {meta && (
          <>
            <span className="font-mono text-xs text-kumo-subtle">{meta.repoRoot}</span>
            <Badge variant="outline">{meta.branch}</Badge>
            <span className="font-mono text-xs">
              <span className="text-kumo-success">+{meta.additions}</span>{" "}
              <span className="text-kumo-danger">−{meta.deletions}</span>
            </span>
          </>
        )}
        <span className="flex-1" />
        {openCount > 0 && <Badge variant="warning">{openCount} open</Badge>}
        <ThemeToggle />
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
            onValueChange={(value) => setLayout(value as Layout)}
          />
        )}
      </header>

      <Sidebar.Provider
        open={sidebarOpen}
        onOpenChange={setSidebarOpen}
        resizable
        defaultWidth={sidebarWidth}
        minWidth={SIDEBAR_MIN_WIDTH}
        maxWidth={SIDEBAR_MAX_WIDTH}
        onWidthChange={setSidebarWidth}
        contained
        mobileBreakpoint={0}
        className="min-h-0 flex-1"
      >
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
            <main className="min-w-0 flex-1 overflow-y-auto">
              {files.map((file) => {
                const path = diffFilePath(file);
                return (
                  <div
                      key={`${reviewId}:${path}`}
                    id={path}
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
      </Sidebar.Provider>
    </div>
  );
}

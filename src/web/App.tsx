import { Badge, Loader, Tabs, useKumoToastManager } from "@cloudflare/kumo";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Comment, CreateCommentRequest, DiffFile, Meta } from "../shared/types";
import { diffFilePath } from "../shared/types";
import { api, useServerEvents } from "./api";
import { DiffView, type Layout } from "./components/DiffView";
import { EmptyState } from "./components/EmptyState";
import { FileList } from "./components/FileList";
import { ThemeToggle } from "./components/ThemeToggle";

export function App() {
  const toasts = useKumoToastManager();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [files, setFiles] = useState<DiffFile[] | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [layout, setLayout] = useState<Layout>("unified");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const refreshDiff = useCallback(async () => {
    try {
      const [meta, diff] = await Promise.all([api.getMeta(), api.getDiff()]);
      setMeta(meta);
      setFiles(diff.files);
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
    onDiff: () => void refreshDiff(),
    onComments: () => void refreshComments(),
  });

  // Toast when an agent marks comments addressed (open → addressed transition
  // that didn't originate from this UI).
  const prevComments = useRef<Comment[]>([]);
  useEffect(() => {
    const prev = prevComments.current;
    const newlyAddressed = comments.filter(
      (c) => c.status === "addressed" && prev.some((p) => p.id === c.id && p.status === "open"),
    );
    if (newlyAddressed.length > 0) {
      toasts.add({
        variant: "success",
        title: `${newlyAddressed.length} comment${newlyAddressed.length === 1 ? "" : "s"} marked addressed by agent`,
      });
    }
    prevComments.current = comments;
  }, [comments, toasts]);

  const submitComment = async (input: CreateCommentRequest) => {
    try {
      await api.createComment(input);
      await refreshComments();
    } catch (err) {
      toasts.add({ variant: "error", title: "Failed to save comment", description: String(err) });
      throw err;
    }
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

  const selected = useMemo(() => {
    if (!files || files.length === 0) return null;
    return files.find((f) => diffFilePath(f) === selectedPath) ?? files[0]!;
  }, [files, selectedPath]);

  const selectedComments = useMemo(
    () => (selected ? comments.filter((c) => c.file === diffFilePath(selected)) : []),
    [comments, selected],
  );

  const openCount = comments.filter((c) => c.status === "open").length;
  const addressedCount = comments.length - openCount;

  if (files === null) {
    return (
      <div className="grid h-full place-items-center">
        <Loader />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-kumo-line bg-kumo-elevated px-4 py-2">
        <span className="text-sm font-semibold">diffreview</span>
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
        {addressedCount > 0 && <Badge variant="success">{addressedCount} addressed</Badge>}
        <ThemeToggle />
        <Tabs
          size="sm"
          tabs={[
            { value: "unified", label: "Unified" },
            { value: "split", label: "Split" },
          ]}
          value={layout}
          onValueChange={(value) => setLayout(value as Layout)}
        />
      </header>

      <div className="flex min-h-0 flex-1">
        {files.length === 0 ? (
          <div className="flex-1">
            <EmptyState />
          </div>
        ) : (
          <>
            <FileList
              files={files}
              comments={comments}
              selectedPath={selected ? diffFilePath(selected) : null}
              onSelect={setSelectedPath}
            />
            <main className="min-w-0 flex-1 overflow-y-auto">
              {selected && (
                <DiffView
                  key={diffFilePath(selected)}
                  file={selected}
                  layout={layout}
                  comments={selectedComments}
                  onSubmitComment={submitComment}
                  onReopen={reopenComment}
                  onDelete={deleteComment}
                />
              )}
            </main>
          </>
        )}
      </div>
    </div>
  );
}

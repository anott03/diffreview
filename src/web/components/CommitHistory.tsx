import { Button } from "@cloudflare/kumo/components/button";
import { Loader } from "@cloudflare/kumo/components/loader";
import { CaretLeftIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CommitSummary, GetCommitDiffResponse, ListCommitsResponse } from "../../shared/types";
import { diffFilePath } from "../../shared/types";
import { useNow } from "../use-relative-time";
import { CommitFileView } from "./CommitFileView";
import { CommitList, formatCommitDate } from "./CommitList";
import type { Layout } from "./DiffView";
import { FileList } from "./FileList";

const COMMIT_PAGE_SIZE = 200;
const COMMIT_FETCH_SIZE = COMMIT_PAGE_SIZE + 1;

export interface CommitHistoryApi {
  getCommits(limit: number, offset: number, signal?: AbortSignal): Promise<ListCommitsResponse>;
  getCommitDiff(commitId: string, signal?: AbortSignal): Promise<GetCommitDiffResponse>;
}

interface CommitHistoryProps {
  api: CommitHistoryApi;
  active: boolean;
  visible: boolean;
  layout: Layout;
  header?: ReactNode;
}

export function CommitHistory({ api, active, visible, layout, header }: CommitHistoryProps) {
  const [commits, setCommits] = useState<CommitSummary[] | null>(null);
  const [commitsError, setCommitsError] = useState<string | null>(null);
  const [commitsRetry, setCommitsRetry] = useState(0);
  const [offset, setOffset] = useState(0);
  const loadedOffset = useRef<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [diff, setDiff] = useState<GetCommitDiffResponse | null>(null);
  const loadedDiffId = useRef<string | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [diffRetry, setDiffRetry] = useState(0);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [sidebarView, setSidebarView] = useState<"commits" | "files">("commits");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [collapsedDirectories, setCollapsedDirectories] = useState<Set<string>>(new Set());
  const fileRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const now = useNow();

  useEffect(() => {
    if (!active || !visible || loadedOffset.current === offset) return;
    const controller = new AbortController();
    setCommitsError(null);
    void api.getCommits(COMMIT_FETCH_SIZE, offset, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      // Fetch one extra commit as a sentinel so an exact page boundary never
      // leaves a "Load more" button that yields an empty page.
      const page = result.commits.slice(0, COMMIT_PAGE_SIZE);
      setCommits((previous) => offset === 0 ? page : [...(previous ?? []), ...page]);
      setHasMore(result.commits.length > COMMIT_PAGE_SIZE);
      loadedOffset.current = offset;
    }).catch((cause) => {
      if (!controller.signal.aborted) setCommitsError(String(cause));
    });
    return () => controller.abort();
  }, [api, active, visible, offset, commitsRetry]);

  useEffect(() => {
    if (!active || !visible || !selectedId || loadedDiffId.current === selectedId) return;
    const controller = new AbortController();
    loadedDiffId.current = null;
    setDiff(null);
    setDiffError(null);
    void api.getCommitDiff(selectedId, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setDiff(result);
      loadedDiffId.current = selectedId;
    }).catch((cause) => {
      if (!controller.signal.aborted) setDiffError(String(cause));
    });
    return () => controller.abort();
  }, [api, active, visible, selectedId, diffRetry]);

  const selectedCommit = useMemo(
    () => commits?.find((commit) => commit.id === selectedId) ?? null,
    [commits, selectedId],
  );

  const toggleCollapsed = (path: string) => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const toggleDirectory = (path: string) => {
    setCollapsedDirectories((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const selectCommit = (id: string) => {
    setSelectedId(id);
    setSelectedPath(null);
    setSidebarView("files");
  };

  const selectCommitFile = (path: string) => {
    setSelectedPath(path);
    setCollapsed((previous) => {
      if (!previous.has(path)) return previous;
      const next = new Set(previous);
      next.delete(path);
      return next;
    });
  };

  useEffect(() => {
    if (!selectedPath) return;
    const el = fileRefs.current[selectedPath];
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [selectedPath]);

  if (!visible) return null;

  const commitFiles = diff?.files ?? [];
  const commitFileEntries = commitFiles.map((file) => {
    const path = diffFilePath(file);
    return {
      path,
      change: { status: file.status, additions: file.additions, deletions: file.deletions },
      commentCount: 0,
    };
  });
  const historySidebarHeader = (
    <div className="flex min-w-0 items-center gap-2">
      {sidebarView === "files" ? (
        <Button variant="ghost" size="sm" icon={CaretLeftIcon} onClick={() => setSidebarView("commits")}>Commits</Button>
      ) : (
        <Button variant="ghost" size="sm" disabled={!selectedId || !diff} onClick={() => setSidebarView("files")}>Files</Button>
      )}
      <div className="min-w-0 flex-1">{header}</div>
    </div>
  );

  return (
    <>
      {sidebarView === "commits" ? (
        <CommitList
          commits={commits}
          error={commitsError}
          onRetry={() => setCommitsRetry((value) => value + 1)}
          hasMore={hasMore}
          onLoadMore={() => setOffset(commits?.length ?? 0)}
          selectedId={selectedId}
          onSelect={selectCommit}
          header={historySidebarHeader}
        />
      ) : (
        <FileList
          title="Commit files"
          commentLabel="files"
          header={historySidebarHeader}
          notice={diffError ? (
            <div role="alert" className="space-y-2 px-3 py-2 text-sm">
              <p className="break-words">Could not load this commit. {diffError}</p>
              <Button variant="secondary" size="sm" onClick={() => setDiffRetry((value) => value + 1)}>Retry</Button>
            </div>
          ) : !diff ? (
            <div role="status" className="flex items-center gap-2 px-3 py-2 text-sm">
              <Loader />Loading commit…
            </div>
          ) : commitFiles.length === 0 ? (
            <p className="px-3 py-2 text-sm text-kumo-subtle">This commit has no file changes.</p>
          ) : null}
          files={commitFileEntries}
          selectedPath={selectedPath}
          onSelect={selectCommitFile}
          collapsedDirectories={collapsedDirectories}
          onToggleDirectory={toggleDirectory}
        />
      )}
      <main className="min-w-0 flex-1 overflow-y-auto [overflow-anchor:none]">
        {!selectedId ? (
          <p className="px-4 py-6 text-sm text-kumo-subtle">Select a commit to view its changes.</p>
        ) : diffError ? (
          <div role="alert" className="space-y-3 px-4 py-6 text-sm">
            <p className="break-words">Could not load this commit. {diffError}</p>
            <Button variant="secondary" size="sm" onClick={() => setDiffRetry((value) => value + 1)}>Retry</Button>
          </div>
        ) : !diff ? (
          <div role="status" className="flex items-center gap-2 px-4 py-6 text-sm">
            <Loader />Loading commit…
          </div>
        ) : (
          <div>
            <div className="border-b border-kumo-line bg-kumo-recessed px-4 py-2 text-sm">
              <div className="flex items-center gap-3">
                <span className="min-w-0 flex-1 truncate font-medium">
                  {selectedCommit?.subject || "(no commit message)"}
                </span>
                <span className="shrink-0 font-mono text-xs text-kumo-subtle" title={selectedCommit?.id}>
                  {selectedCommit?.id.slice(0, 8)}
                </span>
              </div>
              {selectedCommit && (
                <div className="mt-1 flex items-center gap-3 text-xs text-kumo-subtle">
                  <span>{selectedCommit.author}</span>
                  <span>{formatCommitDate(selectedCommit.date, now)}</span>
                </div>
              )}
            </div>
            {commitFiles.length === 0 ? (
              <p className="px-4 py-6 text-sm text-kumo-subtle">This commit has no file changes.</p>
            ) : (
              commitFiles.map((file) => {
                const path = diffFilePath(file);
                return (
                  <div
                    key={`${selectedId}:${path}`}
                    ref={(el) => { fileRefs.current[path] = el; }}
                  >
                    <CommitFileView
                      file={file}
                      layout={layout}
                      collapsed={collapsed.has(path)}
                      onToggleCollapse={() => toggleCollapsed(path)}
                    />
                  </div>
                );
              })
            )}
          </div>
        )}
      </main>
    </>
  );
}

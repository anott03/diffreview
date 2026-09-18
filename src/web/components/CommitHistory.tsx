import { Button } from "@cloudflare/kumo/components/button";
import { Loader } from "@cloudflare/kumo/components/loader";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { CommitSummary, GetCommitDiffResponse, ListCommitsResponse } from "../../shared/types";
import { diffFilePath } from "../../shared/types";
import { useNow } from "../use-relative-time";
import { CommitFileView } from "./CommitFileView";
import { CommitList, formatCommitDate } from "./CommitList";
import type { Layout } from "./DiffView";

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
  const [hasMore, setHasMore] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [diff, setDiff] = useState<GetCommitDiffResponse | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [diffRetry, setDiffRetry] = useState(0);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const now = useNow();

  useEffect(() => {
    if (!active || !visible) return;
    const controller = new AbortController();
    setCommitsError(null);
    void api.getCommits(COMMIT_FETCH_SIZE, offset, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      // Fetch one extra commit as a sentinel so an exact page boundary never
      // leaves a "Load more" button that yields an empty page.
      const page = result.commits.slice(0, COMMIT_PAGE_SIZE);
      setCommits((previous) => offset === 0 ? page : [...(previous ?? []), ...page]);
      setHasMore(result.commits.length > COMMIT_PAGE_SIZE);
    }).catch((cause) => {
      if (!controller.signal.aborted) setCommitsError(String(cause));
    });
    return () => controller.abort();
  }, [api, active, visible, offset, commitsRetry]);

  useEffect(() => {
    if (!active || !visible || !selectedId) {
      setDiff(null);
      return;
    }
    const controller = new AbortController();
    setDiff(null);
    setDiffError(null);
    void api.getCommitDiff(selectedId, controller.signal).then((result) => {
      if (!controller.signal.aborted) setDiff(result);
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

  if (!visible) return null;

  return (
    <>
      <CommitList
        commits={commits}
        error={commitsError}
        onRetry={() => setCommitsRetry((value) => value + 1)}
        hasMore={hasMore}
        onLoadMore={() => setOffset((value) => value + COMMIT_PAGE_SIZE)}
        selectedId={selectedId}
        onSelect={setSelectedId}
        header={header}
      />
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
            {diff.files.length === 0 ? (
              <p className="px-4 py-6 text-sm text-kumo-subtle">This commit has no file changes.</p>
            ) : (
              diff.files.map((file) => {
                const path = diffFilePath(file);
                return (
                  <CommitFileView
                    key={`${selectedId}:${path}`}
                    file={file}
                    layout={layout}
                    collapsed={collapsed.has(path)}
                    onToggleCollapse={() => toggleCollapsed(path)}
                  />
                );
              })
            )}
          </div>
        )}
      </main>
    </>
  );
}

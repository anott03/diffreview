import { Button } from "@cloudflare/kumo/components/button";
import { Loader } from "@cloudflare/kumo/components/loader";
import { Sidebar, useSidebar } from "@cloudflare/kumo/components/sidebar";
import { GitCommitIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import type { CommitSummary } from "../../shared/types";

export function formatCommitDate(ms: number): string {
  const date = new Date(ms);
  const elapsed = Date.now() - ms;
  if (elapsed < 60_000) return "just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  if (elapsed < 7 * 86_400_000) return `${Math.floor(elapsed / 86_400_000)}d ago`;
  return date.toLocaleDateString();
}

interface CommitListProps {
  commits: CommitSummary[] | null;
  error: string | null;
  onRetry: () => void;
  hasMore: boolean;
  onLoadMore: () => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  header?: ReactNode;
}

export function CommitList({
  commits,
  error,
  onRetry,
  hasMore,
  onLoadMore,
  selectedId,
  onSelect,
  header,
}: CommitListProps) {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  const count = commits?.length ?? 0;

  return (
    <Sidebar>
      <div className="flex h-10 shrink-0 items-center border-b border-kumo-line px-3 text-xs font-medium text-kumo-subtle">
        {collapsed ? (
          <span className="w-full text-center" title={`Commits (${count})`}>
            {count}
          </span>
        ) : (
          <div className="min-w-0 flex-1">{header ?? <>Commits ({count})</>}</div>
        )}
      </div>
      <Sidebar.Content>
        {error ? (
          <div role="alert" className="space-y-2 px-3 py-2 text-sm">
            <p className="break-words">Could not load history. {error}</p>
            <Button variant="secondary" size="sm" onClick={onRetry}>Retry</Button>
          </div>
        ) : commits === null ? (
          <div role="status" className="flex items-center gap-2 px-3 py-2 text-sm">
            <Loader />Loading commits…
          </div>
        ) : commits.length === 0 ? (
          <p className="px-3 py-2 text-sm text-kumo-subtle">No commits yet.</p>
        ) : (
          <Sidebar.Menu aria-label="Commits">
            {commits.map((commit) => (
              <Sidebar.MenuItem key={commit.id}>
                <Sidebar.MenuButton
                  icon={<GitCommitIcon size={16} className="shrink-0 text-kumo-subtle" />}
                  active={commit.id === selectedId}
                  aria-current={commit.id === selectedId ? "true" : undefined}
                  aria-label={commit.subject || "(no commit message)"}
                  tooltip={commit.subject || "(no commit message)"}
                  title={commit.subject || "(no commit message)"}
                  className="transition-none"
                  onClick={() => onSelect(commit.id)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">
                      {commit.subject || "(no commit message)"}
                    </span>
                    <span className="block truncate text-xs text-kumo-subtle">
                      {commit.id.slice(0, 8)} · {commit.author} · {formatCommitDate(commit.date)}
                    </span>
                  </span>
                </Sidebar.MenuButton>
              </Sidebar.MenuItem>
            ))}
          </Sidebar.Menu>
        )}
        {hasMore && !error && commits !== null && (
          <div className="border-t border-kumo-line p-2">
            <Button variant="secondary" size="sm" className="w-full" onClick={onLoadMore}>
              Load more
            </Button>
          </div>
        )}
      </Sidebar.Content>
      <Sidebar.Footer>
        <Sidebar.Trigger />
      </Sidebar.Footer>
      <Sidebar.ResizeHandle className="touch-none after:transition-none" />
    </Sidebar>
  );
}
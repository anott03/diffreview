import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Collapsible } from "@cloudflare/kumo/components/collapsible";
import { CaretDownIcon, CaretRightIcon } from "@phosphor-icons/react";
import { useMemo } from "react";
import type { Comment, DiffFile } from "../../shared/types";
import { diffFilePath } from "../../shared/types";
import { diffSyntaxSources } from "../syntax-highlighting";
import { useSyntaxHighlighting } from "../use-syntax-highlighting";
import { SplitDiffTable, UnifiedDiffTable } from "./DiffTable";
import type { Layout } from "./DiffView";

const STATUS_BADGE = {
  added: { variant: "success", label: "added" },
  deleted: { variant: "error", label: "deleted" },
  modified: { variant: "warning", label: "modified" },
  renamed: { variant: "info", label: "renamed" },
} satisfies Record<DiffFile["status"], { variant: "success" | "error" | "warning" | "info"; label: string }>;

interface CommitFileViewProps {
  file: DiffFile;
  layout: Layout;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

export function CommitFileView({ file, layout, collapsed, onToggleCollapse }: CommitFileViewProps) {
  const path = diffFilePath(file);
  const status = STATUS_BADGE[file.status];
  const syntaxSources = useMemo(() => diffSyntaxSources(file, null), [file]);
  const syntaxLines = useSyntaxHighlighting(syntaxSources, !collapsed);
  const noComments = useMemo(() => new Map<string, Comment[]>(), []);
  const noop = () => {};
  const tableProps = {
    file,
    syntaxLines,
    commentsByAnchor: noComments,
    editing: null,
    readOnly: true,
    onDraftBodyChange: noop,
    onStartComment: noop,
    onCancelComment: noop,
    onSubmitComment: async () => {},
    onResolve: noop,
    onReopen: noop,
    onDelete: noop,
  };

  return (
    <Collapsible.Root
      open={!collapsed}
      onOpenChange={() => onToggleCollapse()}
      className="flex flex-col"
    >
      <div className="sticky top-0 z-10 flex h-10 items-center gap-2 border-b border-kumo-line bg-kumo-elevated px-4">
        <Collapsible.Trigger
          render={
            <Button
              shape="square"
              variant="ghost"
              size="sm"
              aria-label={collapsed ? "Expand diff" : "Collapse diff"}
            />
          }
        >
          {collapsed ? <CaretRightIcon size={16} /> : <CaretDownIcon size={16} />}
        </Collapsible.Trigger>
        <Badge variant={status.variant}>{status.label}</Badge>
        <span className="font-mono text-sm">
          {file.status === "renamed" ? `${file.oldPath} → ${file.newPath}` : path}
        </span>
        <span className="flex-1" />
        <span className="font-mono text-xs">
          <span className="text-kumo-success">+{file.additions}</span>{" "}
          <span className="text-kumo-danger">−{file.deletions}</span>
        </span>
      </div>

      <Collapsible.Panel>
        {file.isBinary ? (
          <div className="px-4 py-6 text-sm text-kumo-subtle">
            Binary file — no textual diff to display.
          </div>
        ) : layout === "unified" ? (
          <UnifiedDiffTable {...tableProps} />
        ) : (
          <SplitDiffTable {...tableProps} />
        )}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
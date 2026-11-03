import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Collapsible } from "@cloudflare/kumo/components/collapsible";
import { FileDiff } from "@pierre/diffs/react";
import { CaretDownIcon, CaretRightIcon } from "@phosphor-icons/react";
import { useMemo } from "react";
import type { DiffFile } from "../../shared/types";
import { diffFilePath } from "../../shared/types";
import { toFileDiffMetadata } from "../pierre-diff";
import { useColorMode } from "../use-color-mode";
import { STATUS_BADGE, type Layout } from "./DiffView";
import { diffOptions } from "./pierre-options";

interface CommitFileViewProps {
  file: DiffFile;
  layout: Layout;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

export function CommitFileView({ file, layout, collapsed, onToggleCollapse }: CommitFileViewProps) {
  const path = diffFilePath(file);
  const status = STATUS_BADGE[file.status];
  const colorMode = useColorMode();
  const fileDiff = useMemo(() => toFileDiffMetadata(file, null), [file]);
  const options = useMemo(() => ({ ...diffOptions(layout, colorMode, false), collapsed }), [layout, colorMode, collapsed]);

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
        ) : file.hunks.length === 0 && (
          <div className="px-4 py-2 font-mono text-xs text-kumo-subtle">
            {file.status === "renamed" ? "Renamed without content changes" : "Empty file"}
          </div>
        )}
      </Collapsible.Panel>
      {!file.isBinary && file.hunks.length > 0 && (
        <div hidden={collapsed}>
          <FileDiff fileDiff={fileDiff} options={options} />
        </div>
      )}
    </Collapsible.Root>
  );
}

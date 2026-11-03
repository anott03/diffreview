import { Collapsible } from "@cloudflare/kumo/components/collapsible";
import { FileDiff } from "@pierre/diffs/react";
import { useMemo } from "react";
import type { DiffFile } from "../../shared/types";
import { DiffFileHeader, type Layout } from "../../ui/DiffFileHeader";
import { toFileDiffMetadata } from "../../ui/pierre-diff";
import { diffOptions } from "../../ui/pierre-options";
import { useColorMode } from "../../ui/use-color-mode";

interface CommitFileViewProps {
  file: DiffFile;
  layout: Layout;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

export function CommitFileView({ file, layout, collapsed, onToggleCollapse }: CommitFileViewProps) {
  const colorMode = useColorMode();
  const fileDiff = useMemo(() => toFileDiffMetadata(file, null), [file]);
  const options = useMemo(() => ({ ...diffOptions(layout, colorMode, false), collapsed }), [layout, colorMode, collapsed]);

  return (
    <Collapsible.Root
      open={!collapsed}
      onOpenChange={() => onToggleCollapse()}
      className="flex flex-col"
    >
      <DiffFileHeader file={file} collapsed={collapsed} />

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

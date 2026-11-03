import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Collapsible } from "@cloudflare/kumo/components/collapsible";
import { CaretDownIcon, CaretRightIcon } from "@phosphor-icons/react";
import { diffFilePath, type DiffFile } from "../core/diff-model";

export type Layout = "unified" | "split";

const STATUS_BADGE = {
  added: { variant: "success", label: "added" },
  deleted: { variant: "error", label: "deleted" },
  modified: { variant: "warning", label: "modified" },
  renamed: { variant: "info", label: "renamed" },
} satisfies Record<DiffFile["status"], { variant: "success" | "error" | "warning" | "info"; label: string }>;

/** Must render inside a `Collapsible.Root`, which owns the collapse state its trigger toggles. */
export function DiffFileHeader({ file, collapsed }: { file: DiffFile; collapsed: boolean }) {
  const status = STATUS_BADGE[file.status];
  return (
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
        {file.status === "renamed" ? `${file.oldPath} → ${file.newPath}` : diffFilePath(file)}
      </span>
      <span className="flex-1" />
      <span className="font-mono text-xs">
        <span className="text-kumo-success">+{file.additions}</span>{" "}
        <span className="text-kumo-danger">−{file.deletions}</span>
      </span>
    </div>
  );
}

import { Badge } from "@cloudflare/kumo/components/badge";
import { cn } from "@cloudflare/kumo/utils";
import { ArrowRight, FileMinus, FilePlus, NotePencil } from "@phosphor-icons/react";
import type { Comment, DiffFile, DiffFileStatus } from "../../shared/types";
import { diffFilePath } from "../../shared/types";

const STATUS_META: Record<DiffFileStatus, { icon: typeof FilePlus; className: string; label: string }> = {
  added: { icon: FilePlus, className: "text-kumo-success", label: "added" },
  deleted: { icon: FileMinus, className: "text-kumo-danger", label: "deleted" },
  modified: { icon: NotePencil, className: "text-kumo-warning", label: "modified" },
  renamed: { icon: ArrowRight, className: "text-kumo-info", label: "renamed" },
};

interface FileListProps {
  files: DiffFile[];
  comments: Comment[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
}

export function FileList({ files, comments, selectedPath, onSelect }: FileListProps) {
  return (
    <aside className="flex h-full w-72 shrink-0 flex-col overflow-y-auto border-r border-kumo-line bg-kumo-elevated">
      <div className="flex h-10 items-center border-b border-kumo-line px-3 text-xs font-medium text-kumo-subtle">
        Changed files ({files.length})
      </div>
      <ul className="flex-1 py-1">
        {files.map((file) => {
          const path = diffFilePath(file);
          const meta = STATUS_META[file.status];
          const Icon = meta.icon;
          const openCount = comments.filter((c) => c.file === path && c.status === "open").length;
          const selected = path === selectedPath;
          return (
            <li key={path}>
              <button
                type="button"
                onClick={() => onSelect(path)}
                title={`${path} (${meta.label})`}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-kumo-control",
                  selected && "bg-kumo-control",
                )}
              >
                <Icon size={14} className={cn("shrink-0", meta.className)} />
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{path}</span>
                {openCount > 0 && (
                  <Badge variant="warning" className="shrink-0">
                    {openCount}
                  </Badge>
                )}
                <span className="shrink-0 font-mono text-xs">
                  <span className="text-kumo-success">+{file.additions}</span>{" "}
                  <span className="text-kumo-danger">−{file.deletions}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

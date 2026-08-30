import { Sidebar, useSidebar } from "@cloudflare/kumo/components/sidebar";
import { cn } from "@cloudflare/kumo/utils";
import {
  ArrowRightIcon,
  FileMinusIcon,
  FilePlusIcon,
  NotePencilIcon,
} from "@phosphor-icons/react";
import type { Comment, DiffFile, DiffFileStatus } from "../../shared/types";
import { diffFilePath } from "../../shared/types";

const STATUS_META: Record<DiffFileStatus, { icon: typeof FilePlusIcon; className: string; label: string }> = {
  added: { icon: FilePlusIcon, className: "text-kumo-success", label: "added" },
  deleted: { icon: FileMinusIcon, className: "text-kumo-danger", label: "deleted" },
  modified: { icon: NotePencilIcon, className: "text-kumo-warning", label: "modified" },
  renamed: { icon: ArrowRightIcon, className: "text-kumo-info", label: "renamed" },
};

interface FileListProps {
  files: DiffFile[];
  comments: Comment[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
}

export function FileList({ files, comments, selectedPath, onSelect }: FileListProps) {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  return (
    <Sidebar>
      <div className="flex h-10 shrink-0 items-center border-b border-kumo-line px-3 text-xs font-medium text-kumo-subtle">
        {collapsed ? (
          <span className="w-full text-center" title={`${files.length} changed files`}>
            {files.length}
          </span>
        ) : (
          <>Changed files ({files.length})</>
        )}
      </div>
      <Sidebar.Content>
        <Sidebar.Menu>
          {files.map((file) => {
            const path = diffFilePath(file);
            const meta = STATUS_META[file.status];
            const Icon = meta.icon;
            const openCount = comments.filter((c) => c.file === path && c.status === "open").length;
            return (
              <Sidebar.MenuButton
                key={path}
                icon={<Icon size={16} className={cn("shrink-0", meta.className)} />}
                active={path === selectedPath}
                tooltip={`${path} (${meta.label})`}
                title={`${path} (${meta.label})`}
                onClick={() => onSelect(path)}
              >
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{path}</span>
                {openCount > 0 && (
                  <Sidebar.MenuBadge className="border-kumo-warning/50 text-kumo-warning">
                    {openCount}
                  </Sidebar.MenuBadge>
                )}
                <span className="shrink-0 font-mono text-xs">
                  <span className="text-kumo-success">+{file.additions}</span>{" "}
                  <span className="text-kumo-danger">−{file.deletions}</span>
                </span>
              </Sidebar.MenuButton>
            );
          })}
        </Sidebar.Menu>
      </Sidebar.Content>
      <Sidebar.Footer>
        <Sidebar.Trigger />
      </Sidebar.Footer>
    </Sidebar>
  );
}

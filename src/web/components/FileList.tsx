import { Sidebar, useSidebar } from "@cloudflare/kumo/components/sidebar";
import { cn } from "@cloudflare/kumo/utils";
import {
  ArrowRightIcon,
  CaretDownIcon,
  CaretRightIcon,
  FileIcon,
  FileMinusIcon,
  FilePlusIcon,
  FolderIcon,
  FolderOpenIcon,
  NotePencilIcon,
} from "@phosphor-icons/react";
import { useMemo, type ReactNode } from "react";
import type { DiffFileStatus } from "../../shared/types";
import { buildPathTree, type FileTreeNode } from "../file-tree";

const STATUS_META: Record<DiffFileStatus, { icon: typeof FilePlusIcon; className: string; label: string }> = {
  added: { icon: FilePlusIcon, className: "text-kumo-success", label: "added" },
  deleted: { icon: FileMinusIcon, className: "text-kumo-danger", label: "deleted" },
  modified: { icon: NotePencilIcon, className: "text-kumo-warning", label: "modified" },
  renamed: { icon: ArrowRightIcon, className: "text-kumo-info", label: "renamed" },
};

export interface FileListEntry {
  path: string;
  change?: { status: DiffFileStatus; additions: number; deletions: number };
  commentCount: number;
}

interface FileListProps {
  files: FileListEntry[];
  title?: string;
  commentLabel?: string;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  collapsedDirectories: Set<string>;
  onToggleDirectory: (path: string) => void;
}

export function FileList({ files, title = "Changed files", commentLabel = "open comments", selectedPath, onSelect, collapsedDirectories, onToggleDirectory }: FileListProps) {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  const tree = useMemo(() => buildPathTree(files, (file) => file.path), [files]);

  const renderFile = (file: FileListEntry, name: string, depth: number) => {
    const { path, change, commentCount } = file;
    const meta = change ? STATUS_META[change.status] : undefined;
    const Icon = meta?.icon ?? FileIcon;
    const label = meta ? `${path} (${meta.label})` : path;
    return (
      <Sidebar.MenuItem key={`file:${path}`}>
        <Sidebar.MenuButton
          icon={<Icon size={16} className={cn("shrink-0", meta?.className ?? "text-kumo-subtle")} />}
          active={path === selectedPath}
          aria-current={path === selectedPath ? "true" : undefined}
          aria-label={label}
          tooltip={label}
          title={label}
          style={collapsed ? undefined : { paddingLeft: 12 + depth * 16 }}
          className="transition-none"
          onClick={() => onSelect(path)}
        >
          <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
          {commentCount > 0 && (
            <Sidebar.MenuBadge className={commentLabel === "open comments" ? "border-kumo-warning/50 text-kumo-warning" : undefined} title={`${commentCount} ${commentLabel}`}>
              {commentCount}
            </Sidebar.MenuBadge>
          )}
          {change && (
            <span className="shrink-0 font-mono text-xs">
              <span className="text-kumo-success">+{change.additions}</span>{" "}
              <span className="text-kumo-danger">−{change.deletions}</span>
            </span>
          )}
        </Sidebar.MenuButton>
      </Sidebar.MenuItem>
    );
  };

  const renderNodes = (nodes: FileTreeNode<FileListEntry>[], depth: number): ReactNode[] => nodes.map((node) => {
    if (node.kind === "file") return renderFile(node.file, node.name, depth);
    const expanded = !collapsedDirectories.has(node.path);
    const Caret = expanded ? CaretDownIcon : CaretRightIcon;
    const Folder = expanded ? FolderOpenIcon : FolderIcon;
    return (
      <Sidebar.MenuItem key={`directory:${node.path}`}>
        <Sidebar.MenuButton
          icon={<Caret size={16} className="shrink-0 text-kumo-subtle" />}
          aria-expanded={expanded}
          aria-label={node.path}
          title={node.path}
          style={{ paddingLeft: 12 + depth * 16 }}
          className="transition-none"
          onClick={() => onToggleDirectory(node.path)}
        >
          <Folder size={16} className="shrink-0 text-kumo-subtle" />
          <span className="min-w-0 truncate text-sm">{node.name}</span>
        </Sidebar.MenuButton>
        {expanded && <Sidebar.Menu aria-label={node.path}>{renderNodes(node.children, depth + 1)}</Sidebar.Menu>}
      </Sidebar.MenuItem>
    );
  });

  return (
    <Sidebar>
      <div className="flex h-10 shrink-0 items-center border-b border-kumo-line px-3 text-xs font-medium text-kumo-subtle">
        {collapsed ? (
          <span className="w-full text-center" title={`${title} (${files.length})`}>
            {files.length}
          </span>
        ) : (
          <>{title} ({files.length})</>
        )}
      </div>
      <Sidebar.Content>
        <Sidebar.Menu aria-label={title}>
          {collapsed
            ? files.map((file) => renderFile(file, file.path, 0))
            : renderNodes(tree, 0)}
        </Sidebar.Menu>
      </Sidebar.Content>
      <Sidebar.Footer>
        <Sidebar.Trigger />
      </Sidebar.Footer>
      <Sidebar.ResizeHandle className="touch-none after:transition-none" />
    </Sidebar>
  );
}

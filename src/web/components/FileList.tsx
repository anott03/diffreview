import { Sidebar, useSidebar } from "@cloudflare/kumo/components/sidebar";
import { cn } from "@cloudflare/kumo/utils";
import {
  ArrowRightIcon,
  CaretDownIcon,
  CaretRightIcon,
  FileMinusIcon,
  FilePlusIcon,
  FolderIcon,
  FolderOpenIcon,
  NotePencilIcon,
} from "@phosphor-icons/react";
import { useMemo, type ReactNode } from "react";
import type { Comment, DiffFile, DiffFileStatus } from "../../shared/types";
import { diffFilePath } from "../../shared/types";
import { buildFileTree, type FileTreeNode } from "../file-tree";

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
  collapsedDirectories: Set<string>;
  onToggleDirectory: (path: string) => void;
}

export function FileList({ files, comments, selectedPath, onSelect, collapsedDirectories, onToggleDirectory }: FileListProps) {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  const tree = useMemo(() => buildFileTree(files), [files]);
  const openCounts = new Map<string, number>();
  for (const comment of comments) {
    if (comment.status === "open") {
      openCounts.set(comment.file, (openCounts.get(comment.file) ?? 0) + 1);
    }
  }

  const renderFile = (file: DiffFile, name: string, depth: number) => {
    const path = diffFilePath(file);
    const meta = STATUS_META[file.status];
    const Icon = meta.icon;
    const openCount = openCounts.get(path) ?? 0;
    return (
      <Sidebar.MenuItem key={`file:${path}`}>
        <Sidebar.MenuButton
          icon={<Icon size={16} className={cn("shrink-0", meta.className)} />}
          active={path === selectedPath}
          aria-current={path === selectedPath ? "true" : undefined}
          aria-label={`${path} (${meta.label})`}
          tooltip={`${path} (${meta.label})`}
          title={`${path} (${meta.label})`}
          style={collapsed ? undefined : { paddingLeft: 12 + depth * 16 }}
          className="transition-none"
          onClick={() => onSelect(path)}
        >
          <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
          {openCount > 0 && (
            <Sidebar.MenuBadge className="border-kumo-warning/50 text-kumo-warning" title={`${openCount} open comments`}>
              {openCount}
            </Sidebar.MenuBadge>
          )}
          <span className="shrink-0 font-mono text-xs">
            <span className="text-kumo-success">+{file.additions}</span>{" "}
            <span className="text-kumo-danger">−{file.deletions}</span>
          </span>
        </Sidebar.MenuButton>
      </Sidebar.MenuItem>
    );
  };

  const renderNodes = (nodes: FileTreeNode[], depth: number): ReactNode[] => nodes.map((node) => {
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
          <span className="w-full text-center" title={`${files.length} changed files`}>
            {files.length}
          </span>
        ) : (
          <>Changed files ({files.length})</>
        )}
      </div>
      <Sidebar.Content>
        <Sidebar.Menu aria-label="Changed files">
          {collapsed
            ? files.map((file) => renderFile(file, diffFilePath(file), 0))
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

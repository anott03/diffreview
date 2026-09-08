import { diffFilePath, type DiffFile } from "../shared/types";

export type FileTreeNode =
  | { kind: "file"; name: string; path: string; file: DiffFile }
  | { kind: "directory"; name: string; path: string; children: FileTreeNode[] };

export function buildFileTree(files: DiffFile[]): FileTreeNode[] {
  const roots: FileTreeNode[] = [];
  const directories = new Map<string, Extract<FileTreeNode, { kind: "directory" }>>();

  for (const file of files) {
    const path = diffFilePath(file);
    const parts = path.split("/");
    const name = parts.pop()!;
    let children = roots;
    let directoryPath = "";
    for (const part of parts) {
      directoryPath = directoryPath ? `${directoryPath}/${part}` : part;
      let directory = directories.get(directoryPath);
      if (!directory) {
        directory = { kind: "directory", name: part, path: directoryPath, children: [] };
        directories.set(directoryPath, directory);
        children.push(directory);
      }
      children = directory.children;
    }
    children.push({ kind: "file", name, path, file });
  }

  const sort = (nodes: FileTreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });
    for (const node of nodes) {
      if (node.kind === "directory") sort(node.children);
    }
  };
  sort(roots);
  return roots;
}

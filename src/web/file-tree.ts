import { diffFilePath, type DiffFile } from "../shared/types";

export type FileTreeNode<T = DiffFile> =
  | { kind: "file"; name: string; path: string; file: T }
  | { kind: "directory"; name: string; path: string; children: FileTreeNode<T>[] };

export function buildFileTree(files: DiffFile[]): FileTreeNode[] {
  return buildPathTree(files, diffFilePath);
}

export function buildPathTree<T>(files: T[], getPath: (file: T) => string): FileTreeNode<T>[] {
  const roots: FileTreeNode<T>[] = [];
  const directories = new Map<string, Extract<FileTreeNode<T>, { kind: "directory" }>>();

  for (const file of files) {
    const path = getPath(file);
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

  const sort = (nodes: FileTreeNode<T>[]) => {
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

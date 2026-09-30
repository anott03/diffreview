import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { ListDirectoriesResponse } from "../shared/types";

export async function listDirectories(path: string): Promise<ListDirectoriesResponse> {
  const absolute = resolve(path || ".");
  const trailingSeparator = path.endsWith(sep) || path.endsWith("/");
  const parent = trailingSeparator || !path ? absolute : dirname(absolute);
  const prefix = trailingSeparator || !path ? "" : basename(absolute);
  const entries = await readdir(parent, { withFileTypes: true }).catch(() => []);
  const directories: string[] = [];

  for (const entry of entries) {
    if (!entry.name.startsWith(prefix)) continue;
    const child = join(parent, entry.name);
    const isDirectory = entry.isDirectory() || (entry.isSymbolicLink() &&
      (await stat(child).catch(() => null))?.isDirectory());
    if (isDirectory) directories.push(child.endsWith(sep) ? child : `${child}${sep}`);
  }

  directories.sort((left, right) => left.localeCompare(right));
  return { directories };
}

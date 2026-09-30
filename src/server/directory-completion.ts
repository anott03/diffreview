import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { z } from "zod";
import type { ListDirectoriesResponse } from "../shared/types";

const MissingDirectoryErrorSchema = z.object({ code: z.enum(["ENOENT", "ENOTDIR"]) });

export async function listDirectories(path: string): Promise<ListDirectoriesResponse> {
  if (!path) return { directories: [] };
  const absolute = resolve(path);
  const trailingSeparator = path.endsWith(sep) || path.endsWith("/");
  const parent = trailingSeparator ? absolute : dirname(absolute);
  const prefix = trailingSeparator ? "" : basename(absolute).toLowerCase();
  const entries = await readdir(parent, { withFileTypes: true }).catch((cause) => {
    if (MissingDirectoryErrorSchema.safeParse(cause).success) return [];
    throw cause;
  });
  const directories: string[] = [];

  for (const entry of entries) {
    if (!entry.name.toLowerCase().startsWith(prefix)) continue;
    const child = join(parent, entry.name);
    const isDirectory = entry.isDirectory() || (entry.isSymbolicLink() &&
      (await stat(child).catch(() => null))?.isDirectory());
    if (isDirectory) directories.push(`${child}${sep}`);
  }

  directories.sort();
  return { directories };
}

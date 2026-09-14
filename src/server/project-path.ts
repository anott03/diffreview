import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { getRepoRoot } from "./git";

export async function resolveProjectPath(path: string): Promise<string> {
  if (!path.trim()) throw new Error("Project path must not be empty");
  const absolute = resolve(path);
  let directory: string;
  try {
    directory = await realpath(absolute);
  } catch {
    throw new Error(`Project path is missing or inaccessible: ${absolute}`);
  }
  return getRepoRoot(directory);
}

import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, win32 } from "node:path";
import type { FileContent } from "../shared/types";
import { NotFoundError } from "./api";
import { normalizeTextLines } from "./text-lines";

const MAX_FILE_BYTES = 1024 * 1024;
const BINARY_SNIFF_BYTES = 8000;

export function isWorkingTreePath(path: string): boolean {
  return path.length > 0 && !isAbsolute(path) && !win32.isAbsolute(path) && !path.includes("\0") &&
    !path.includes("\\") && path.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git");
}

function checkedPath(root: string, path: string): string {
  if (!isWorkingTreePath(path)) throw new NotFoundError({ error: "file not found" });
  const absolute = join(root, path);
  if (realpathSync(dirname(absolute)) !== dirname(absolute)) {
    throw new NotFoundError({ error: "file not found" });
  }
  return absolute;
}

export function listWorkingTreeFiles(root: string, output: string): string[] {
  const files: string[] = [];
  for (const path of new Set(output.split("\0").filter(Boolean))) {
    try {
      if (!lstatSync(checkedPath(root, path)).isDirectory()) files.push(path);
    } catch {
      continue;
    }
  }
  return files.sort();
}

function readWorkingTreeSymlink(root: string, path: string, absolute: string): string {
  const parent = dirname(absolute);
  const before = lstatSync(parent);
  const fd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    checkedPath(root, path);
    if (opened.dev !== before.dev || opened.ino !== before.ino ||
      (process.platform === "linux" && realpathSync(`/proc/self/fd/${fd}`) !== parent)) {
      throw new NotFoundError({ error: "file not found" });
    }
    const linkPath = process.platform === "linux" ? `/proc/self/fd/${fd}/${basename(absolute)}` : absolute;
    const target = readlinkSync(linkPath, "utf8");
    checkedPath(root, path);
    const after = lstatSync(parent);
    if (after.dev !== opened.dev || after.ino !== opened.ino ||
      (process.platform === "linux" && realpathSync(`/proc/self/fd/${fd}`) !== parent)) {
      throw new NotFoundError({ error: "file not found" });
    }
    return target;
  } finally {
    closeSync(fd);
  }
}

export function readWorkingTreeFile(root: string, path: string, textMode: "strict" | "git" = "strict"): FileContent {
  const absolute = checkedPath(root, path);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) {
    return { path, kind: "symlink", content: readWorkingTreeSymlink(root, path, absolute) };
  }
  if (!stat.isFile()) return { path, kind: "unsupported", content: null };
  if (stat.size > MAX_FILE_BYTES) return { path, kind: "too-large", content: null };
  const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    checkedPath(root, path);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino ||
      // The /proc re-check covers fd-level symlink swaps; platforms without /proc
      // (macOS) rely only on O_NOFOLLOW plus the dev/ino comparison above.
      (process.platform === "linux" && realpathSync(`/proc/self/fd/${fd}`) !== absolute)) {
      throw new NotFoundError({ error: "file not found" });
    }
    if (!opened.isFile()) return { path, kind: "unsupported", content: null };
    if (opened.size > MAX_FILE_BYTES) return { path, kind: "too-large", content: null };
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_FILE_BYTES) return { path, kind: "too-large", content: null };
    const bytes = buffer.subarray(0, length);
    const sniff = textMode === "git" ? bytes.subarray(0, BINARY_SNIFF_BYTES) : bytes;
    if (sniff.includes(0)) return { path, kind: "binary", content: null };
    if (textMode === "git") {
      return { path, kind: "text", content: normalizeTextLines(bytes.toString("utf8")) };
    }
    try {
      return { path, kind: "text", content: normalizeTextLines(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)) };
    } catch {
      return { path, kind: "binary", content: null };
    }
  } finally {
    closeSync(fd);
  }
}

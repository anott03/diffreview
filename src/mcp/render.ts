import type { DiffFile } from "../shared/types";
import { diffFilePath } from "../shared/types";

/**
 * Renders structured diff files back to unified-diff-style text.
 * Agents consume this format best, and it's far more token-efficient than
 * the structured JSON used by the web UI.
 */
export function renderUnifiedDiff(files: DiffFile[], onlyPath?: string): string {
  const selected = onlyPath ? files.filter((f) => diffFilePath(f) === onlyPath) : files;
  if (selected.length === 0) return "";

  const out: string[] = [];
  for (const file of selected) {
    const path = diffFilePath(file);
    out.push(`diff --git a/${file.oldPath ?? path} b/${file.newPath ?? path}`);
    if (file.status === "added") out.push("new file");
    if (file.status === "deleted") out.push("deleted file");
    if (file.status === "renamed") out.push(`rename from ${file.oldPath}`, `rename to ${file.newPath}`);
    if (file.isBinary) {
      out.push("Binary files differ");
      continue;
    }
    for (const hunk of file.hunks) {
      out.push(hunk.header);
      for (const line of hunk.lines) {
        const prefix = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
        out.push(`${prefix}${line.content}`);
      }
    }
  }
  return out.join("\n");
}

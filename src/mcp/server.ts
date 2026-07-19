import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import pkg from "../../package.json";
import type { Comment, GetDiffResponse, ListCommentsResponse, Meta } from "../shared/types";
import { diffFilePath } from "../shared/types";
import { apiGet, apiPatch, resolveClient, type ResolvedClient } from "./client";
import { renderUnifiedDiff } from "./render";

const MAX_DIFF_CHARS = 100_000;

type ToolTextResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function ok(data: unknown): ToolTextResult {
  return {
    content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
  };
}

function fail(message: string): ToolTextResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Shared preamble for every tool: resolve the diffreview instance for the
 * repo opencode launched us in. Returns either a client or an error result
 * to hand straight back to the agent.
 */
async function connect(): Promise<{ client: ResolvedClient } | { error: ToolTextResult }> {
  const resolved = await resolveClient();
  return resolved.ok ? { client: resolved.client } : { error: fail(resolved.error) };
}

const server = new McpServer({ name: "diffreview", version: pkg.version });

server.registerTool(
  "get_diff_summary",
  {
    description:
      "Summarize the uncommitted changes (vs HEAD) of this git repository: branch, per-file stats, " +
      "and open review-comment counts. A human is reviewing these changes with the diffreview tool; " +
      "use this to orient before reading comments.",
  },
  async () => {
    const conn = await connect();
    if ("error" in conn) return conn.error;
    try {
      const [meta, diff, comments] = await Promise.all([
        apiGet<Meta>(conn.client, "/api/meta"),
        apiGet<GetDiffResponse>(conn.client, "/api/diff"),
        apiGet<ListCommentsResponse>(conn.client, "/api/comments?status=open"),
      ]);
      const openByFile = new Map<string, number>();
      for (const c of comments.comments) {
        openByFile.set(c.file, (openByFile.get(c.file) ?? 0) + 1);
      }
      return ok({
        repoRoot: meta.repoRoot,
        branch: meta.branch,
        head: meta.head,
        totals: {
          files: meta.files,
          additions: meta.additions,
          deletions: meta.deletions,
          openComments: comments.comments.length,
        },
        files: diff.files.map((f) => ({
          path: diffFilePath(f),
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          ...(f.isBinary ? { binary: true } : {}),
          openComments: openByFile.get(diffFilePath(f)) ?? 0,
        })),
      });
    } catch (err) {
      return fail(`failed to fetch diff summary: ${(err as Error).message}`);
    }
  },
);

server.registerTool(
  "get_diff",
  {
    description:
      "Get the uncommitted diff (vs HEAD) that a human is currently reviewing, as unified diff " +
      "text. Pass `file` to limit output to a single file (recommended for large diffs). Use this " +
      "to see the exact code a review comment refers to.",
    inputSchema: {
      file: z
        .string()
        .optional()
        .describe("repo-relative path of a single file to show (e.g. src/index.ts)"),
    },
  },
  async ({ file }) => {
    const conn = await connect();
    if ("error" in conn) return conn.error;
    try {
      const diff = await apiGet<GetDiffResponse>(conn.client, "/api/diff");
      let text = renderUnifiedDiff(diff.files, file);
      if (!text) {
        return fail(
          file
            ? `No uncommitted changes for file: ${file}. Call get_diff_summary for the list of changed files.`
            : "The working tree is clean — no uncommitted changes.",
        );
      }
      if (text.length > MAX_DIFF_CHARS) {
        text = `${text.slice(0, MAX_DIFF_CHARS)}\n\n... (truncated — pass \`file\` to view one file at a time)`;
      }
      return ok(text);
    } catch (err) {
      return fail(`failed to fetch diff: ${(err as Error).message}`);
    }
  },
);

server.registerTool(
  "list_review_comments",
  {
    description:
      "List review comments a human left on your uncommitted changes. Default status is 'open' " +
      "(your work queue). Each comment includes the file, side (old/new), line number, the " +
      "commented line's text, and the human's note. Comments with outdated=true refer to code " +
      "that has changed since the comment was written.",
    inputSchema: {
      status: z
        .enum(["open", "addressed", "all"])
        .optional()
        .describe("filter by status (default: open)"),
      file: z.string().optional().describe("filter to a single repo-relative file path"),
    },
  },
  async ({ status, file }) => {
    const conn = await connect();
    if ("error" in conn) return conn.error;
    try {
      const params = new URLSearchParams({ status: status ?? "open" });
      if (file) params.set("file", file);
      const res = await apiGet<ListCommentsResponse>(conn.client, `/api/comments?${params}`);
      return ok(
        res.comments.map((c) => ({
          id: c.id,
          file: c.file,
          side: c.side,
          line: c.line,
          status: c.status,
          outdated: c.outdated ?? false,
          lineText: c.lineText,
          body: c.body,
          ...(c.note ? { note: c.note } : {}),
          createdAt: new Date(c.createdAt).toISOString(),
        })),
      );
    } catch (err) {
      return fail(`failed to list comments: ${(err as Error).message}`);
    }
  },
);

server.registerTool(
  "mark_comment_addressed",
  {
    description:
      "Mark a human's review comment as addressed AFTER you have actually fixed the issue in " +
      "code. Include a short note describing what you changed. Never mark a comment addressed " +
      "without making the corresponding code change first.",
    inputSchema: {
      id: z.string().describe("comment id, from list_review_comments"),
      note: z.string().optional().describe("short description of the fix (visible to the human)"),
    },
  },
  async ({ id, note }) => {
    const conn = await connect();
    if ("error" in conn) return conn.error;
    try {
      const updated = await apiPatch<Comment>(conn.client, `/api/comments/${id}`, {
        status: "addressed",
        ...(note ? { note } : {}),
      });
      if (!updated) {
        return fail(`Comment not found: ${id}. Call list_review_comments with status=all to see current comments.`);
      }
      return ok(updated);
    } catch (err) {
      return fail(`failed to mark comment addressed: ${(err as Error).message}`);
    }
  },
);

await server.connect(new StdioServerTransport());
// stderr only — stdout is the JSON-RPC channel.
console.error(`diffreview-mcp ${pkg.version} running on stdio`);

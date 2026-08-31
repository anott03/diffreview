import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import pkg from "../../package.json";
import { getRepoRoot } from "./git";
import { WatcherCompat } from "./watcher";
import { createApp, findWebRoot, startServer } from "./index";
import { dbPathForRepo } from "./paths";
import { clearSession, writeSession } from "./session";
import type { CommentStoreCompat } from "./store";

const USAGE = `Usage: diffreview [repoPath] [options]

  Review uncommitted changes (vs HEAD) of a git repo in a local web UI,
  with inline comments that AI agents can read and mark as addressed.

Arguments:
  repoPath          Path to the git repository (default: current directory)

Options:
  -p, --port <n>    Port to listen on (default: 4777)
      --open        Open the UI in a browser
  -h, --help        Show this help
  -v, --version     Show version
`;

function fail(message: string): never {
  console.error(`diffreview: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      port: { type: "string", short: "p", default: "4777" },
      open: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
    allowPositionals: true,
  });

  if (values.help || values.version) {
    console.log(values.version ? `diffreview ${pkg.version}` : USAGE);
    return;
  }

  const port = Number.parseInt(values.port ?? "4777", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`invalid port: ${values.port}`);
  }

  const target = resolve(positionals[0] ?? ".");
  let repoRoot: string;
  try {
    repoRoot = await getRepoRoot(target);
  } catch (err) {
    fail((err as Error).message);
  }

  // Resolve all filesystem and SQLite access after argument validation so
  // `diffreview --help` is silent and fast.
  const { CommentStoreCompat } = await import("./store.js");
  const store = new CommentStoreCompat(dbPathForRepo(repoRoot)) as CommentStoreCompat;
  const watcher = new WatcherCompat(repoRoot, 2000);
  const app = createApp({ repoRoot, store, watcher });

  let server: Awaited<ReturnType<typeof startServer>>;
  try {
    server = await startServer(app, port);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fail(message.toLowerCase().includes("eaddrinuse")
      ? `port ${port} is already in use (another diffreview instance running? try --port)`
      : `could not start server: ${message}`);
  }

  writeSession({ port, pid: process.pid, repoRoot, startedAt: Date.now() });

  const shutdown = () => {
    clearSession(repoRoot);
    watcher.stop();
    store.close();
    server.close();
  };
  process.on("exit", shutdown);
  process.on("SIGINT", () => {
    shutdown();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    shutdown();
    process.exit(143);
  });

  // One synchronous refresh so the first page load has data, then poll.
  await watcher.refresh().catch(() => {});
  watcher.start();

  const url = `http://127.0.0.1:${port}`;
  const uiLine = findWebRoot()
    ? `UI:         ${url}`
    : `UI:         not built — run \`pnpm build\` to serve it from ${url}\n              (dev mode: open the vite dev server at http://localhost:5173)`;
  console.log(`diffreview ${pkg.version}

  Reviewing:  ${repoRoot}
  ${uiLine}
  Comments:   ${dbPathForRepo(repoRoot)}

  opencode MCP config (add to opencode.json):
    "mcp": {
      "diffreview": { "type": "local", "command": ["diffreview-mcp"], "enabled": true }
    }
`);

  if (values.open) {
    spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  }
}

void main().catch((err) => {
  console.error("diffreview:", err instanceof Error ? err.message : err);
  process.exit(1);
});

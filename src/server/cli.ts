import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Effect } from "effect";
import { NodeRuntime } from "@effect/platform-node";
import pkg from "../../package.json";
import { getRepoRoot } from "./git";
import { Watcher } from "./watcher";
import { findWebRoot, serverLayer } from "./http";
import { dbPathForRepo } from "./paths";
import { Session } from "./session";
import { ServerConfig } from "./config";

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

const errMessage = (e: unknown): string => {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === "object" && e !== null) {
    const anyErr = e as { message?: unknown; cause?: unknown };
    if (typeof anyErr.message === "string" && anyErr.message) return anyErr.message;
    if (anyErr.cause instanceof Error && anyErr.cause.message) return anyErr.cause.message;
  }
  return "internal error";
};

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

  const webRoot = findWebRoot();
  const dbPath = dbPathForRepo(repoRoot);
  const url = `http://127.0.0.1:${port}`;

  // The server layer starts listening during layer construction; the program
  // body then runs with all services in scope and parks forever (interrupts
  // via SIGINT/SIGTERM unwind the scope: server close, poll fiber interrupt,
  // sqlite close, session-file clear).
  // E: ServeError (http) | PlatformError (static) | StoreError (db open)
  const MainLive = serverLayer({
    repoRoot,
    port,
    intervalMs: 2000,
    open: values.open ?? false,
    dbPath,
    webRoot,
  });

  const program = Effect.gen(function*() {
    const session = yield* Session;
    const watcher = yield* Watcher;
    const config = yield* ServerConfig;

    yield* Effect.catch(session.write({
      port: config.port,
      pid: process.pid,
      repoRoot: config.repoRoot,
      startedAt: Date.now(),
    }), (err) => Effect.sync(() => fail(errMessage(err))));
    // Cleared on any program exit path (SIGINT/SIGTERM interrupt included).
    yield* Effect.addFinalizer(() => session.clear(config.repoRoot));

    // One synchronous refresh so the first page load has data, then poll.
    yield* Effect.catch(watcher.refresh(), () => Effect.void);

    const uiLine = webRoot
      ? `UI:         ${url}`
      : `UI:         not built — run \`pnpm build\` to serve it from ${url}\n              (dev mode: open the vite dev server at http://localhost:5173)`;
    yield* Effect.sync(() => console.log(`diffreview ${pkg.version}

  Reviewing:  ${repoRoot}
  ${uiLine}
  Comments:   ${dbPath}

  opencode MCP config (add to opencode.json):
    "mcp": {
      "diffreview": { "type": "local", "command": ["diffreview-mcp"], "enabled": true }
    }
`));

    if (config.open) {
      yield* Effect.sync(() => {
        spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
      });
    }

    yield* Effect.never;
  }).pipe(
    Effect.provide(MainLive),
    // Startup failures surface from layer construction (e.g. EADDRINUSE).
    Effect.catch((err) => {
      if (errMessage(err).toLowerCase().includes("eaddrinuse")) {
        return Effect.sync(() =>
          fail(`port ${port} is already in use (another diffreview instance running? try --port)`)
        );
      }
      return Effect.sync(() => fail(`could not start server: ${errMessage(err)}`));
    }),
  );

  // Scoped: the session/db finalizers run when the fiber is interrupted
  // (SIGINT/SIGTERM via runMain). Effect.never keeps the scope open until then.
  NodeRuntime.runMain(Effect.scoped(program));
}

void main().catch((err) => {
  console.error("diffreview:", err instanceof Error ? err.message : err);
  process.exit(1);
});

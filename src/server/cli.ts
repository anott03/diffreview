import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Effect } from "effect";
import { NodeRuntime } from "@effect/platform-node";
import pkg from "../../package.json";
import { findWebRoot, serverLayer } from "./http";
import { resolveProjectPath } from "./project-path";
import { errMessage } from "./error-message";
import {
  acquireServerLock,
  clearServerDescriptor,
  discoverServer,
  ensureServer,
  registerProject,
  serverDescriptorPath,
  verifyServer,
  writeServerDescriptor,
  type ServerDescriptor,
} from "./server-discovery";

const USAGE = `Usage: diffreview [open] [path] [options]
       diffreview serve [options]

Commands:
  open [path]       Register a Git working tree with the global server and open
                   its browser UI. Starts a detached server if needed.
                   The path defaults to the current directory.
  serve             Run the global server in the foreground, without opening
                   a project or browser. Works outside a Git repository.

Options:
  -p, --port <n>    Server port (default for a new server: 4777).
                   An existing server is reused unless an explicit port differs.
      --no-open     Print the project URL without opening a browser
      --open        Open the browser (default for open and shorthand)
  -h, --help        Show this help
  -v, --version     Show version

Stop old per-repository diffreview processes before starting the global server.
Stop the global server with SIGTERM to the PID in its server.json descriptor.
`;

function openBrowser(url: string): Promise<void> {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  return new Promise((resolveOpen, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolveOpen();
    });
  });
}

function serve(port: number): void {
  const descriptor: ServerDescriptor = {
    service: "diffreview",
    protocolVersion: 1,
    instanceId: randomUUID(),
    pid: process.pid,
    startedAt: Date.now(),
    endpoint: `http://127.0.0.1:${port}`,
  };
  const webRoot = findWebRoot();
  const program = Effect.gen(function*() {
    yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const existing = await discoverServer();
          if (existing) throw new Error(`The global server is already running at ${existing.endpoint}. Use diffreview open to attach.`);
          const lock = await acquireServerLock();
          if (!lock) throw new Error(`Another global server is starting or running. Use diffreview open to attach. Discovery: ${serverDescriptorPath()}`);
          return lock;
        },
        catch: (cause) => new Error(errMessage(cause)),
      }),
      (lock) => Effect.sync(() => lock.release()),
    );

    yield* Effect.gen(function*() {
      yield* Effect.addFinalizer(() => Effect.sync(() => clearServerDescriptor(descriptor.instanceId)));
      yield* Effect.tryPromise({
        try: async () => {
          if (!await verifyServer(descriptor)) throw new Error(`Server identity check failed at ${descriptor.endpoint}`);
          writeServerDescriptor(descriptor);
        },
        catch: (cause) => new Error(errMessage(cause)),
      });
      yield* Effect.sync(() => {
        console.log(`diffreview ${pkg.version}\n\n  Server: ${descriptor.endpoint}\n  PID: ${descriptor.pid}\n  Discovery: ${serverDescriptorPath()}`);
        if (!webRoot) console.log("  UI not built. Run pnpm build, or use the Vite UI at http://localhost:5173.");
      });
      yield* Effect.never;
    }).pipe(Effect.provide(serverLayer({
      port,
      intervalMs: 2000,
      webRoot,
      instanceId: descriptor.instanceId,
      startedAt: descriptor.startedAt,
    })));
  }).pipe(
    Effect.scoped,
    Effect.mapError((error) => {
      const message = errMessage(error);
      return new Error(message.toLowerCase().includes("eaddrinuse")
        ? `Port ${port} is already in use. Stop the process using it or choose another --port. Stop old per-repository diffreview servers before upgrading.`
        : `Could not start server: ${message}`);
    }),
  );
  NodeRuntime.runMain(program);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      port: { type: "string", short: "p" },
      open: { type: "boolean" },
      "no-open": { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
    allowPositionals: true,
  });
  if (values.help || values.version) {
    console.log(values.version ? `diffreview ${pkg.version}` : USAGE);
    return;
  }
  const port = values.port === undefined ? undefined : Number(values.port);
  if (port !== undefined && (!/^\d+$/.test(values.port ?? "") || !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error(`Invalid port: ${values.port}`);
  }
  if (values.open && values["no-open"]) throw new Error("Choose either --open or --no-open.");
  const command = positionals[0] === "serve" ? "serve" : "open";
  const paths = positionals[0] === "serve" || positionals[0] === "open" ? positionals.slice(1) : positionals;
  if (paths.length > (command === "serve" ? 0 : 1)) throw new Error(`Unexpected arguments.\n${USAGE}`);
  if (command === "serve") {
    serve(port ?? 4777);
    return;
  }
  const path = resolve(paths[0] ?? ".");
  await resolveProjectPath(path);
  const entryPath = process.argv[1];
  if (!entryPath) throw new Error("Cannot determine the CLI entry point for server startup.");
  const server = await ensureServer({ entryPath: resolve(entryPath), port });
  const project = await registerProject(server, path);
  const url = `${server.endpoint}/projects/${encodeURIComponent(project.id)}`;
  console.log(url);
  if (!values["no-open"]) {
    try {
      await openBrowser(url);
    } catch (cause) {
      console.error(`Could not open a browser: ${errMessage(cause)}. Open the URL above manually.`);
    }
  }
}

void main().catch((cause) => {
  console.error(`diffreview: ${errMessage(cause)}`);
  process.exitCode = 1;
});

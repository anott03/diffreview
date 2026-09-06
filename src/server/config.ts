/**
 * Immutable server configuration.
 *
 * Parsed once by the cli and provided through the MainLive layer as
 * `Layer.succeed` — a plain typed value, not env-backed `Config` (the cli
 * parses argv, not the environment).
 */
import { Context } from "effect";

export class ServerConfig extends Context.Service<ServerConfig, {
  readonly repoRoot: string;
  readonly port: number;
  /** Watcher poll interval. */
  readonly intervalMs: number;
  /** `--open`: open the UI in a browser after startup. */
  readonly open: boolean;
  readonly dbPath: string;
  readonly webRoot: string | null;
}>()("diffreview/server/ServerConfig") {}

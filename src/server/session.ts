import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Context, Effect, Layer, Semaphore } from "effect";
import type { SessionInfo } from "../shared/types";
import { sessionPathForRepo, sessionsDir } from "./paths";

/**
 * The session file is how diffreview-mcp (spawned by opencode with the repo
 * as cwd) discovers the running server for that repo. Stale files (crash)
 * are tolerated: readers must verify pid/port before use.
 */
export function writeSession(info: SessionInfo): void {
  mkdirSync(sessionsDir(), { recursive: true });
  writeFileSync(sessionPathForRepo(info.repoRoot), JSON.stringify(info, null, 2));
}

export function readSession(repoRoot: string): SessionInfo | null {
  try {
    return JSON.parse(readFileSync(sessionPathForRepo(repoRoot), "utf8")) as SessionInfo;
  } catch {
    return null;
  }
}

export function clearSession(repoRoot: string): void {
  try {
    rmSync(sessionPathForRepo(repoRoot));
  } catch {
    // Already gone.
  }
}

/** FS failure while writing/reading a session file. */
export interface SessionError {
  readonly op: "write" | "read";
  readonly cause: unknown;
}

/**
 * Session file access as an Effect service.
 *
 * The free functions above are the interim bridge (cli + mcp discovery still
 * call them directly); step 9 of .thoughts/effect-migration.md moves the cli
 * flow onto this service, wired through MainLive.
 *
 * Deliberately NOT auto-clearing on layer release: the session file must
 * outlive test-scoped layers, and the cli flow owns the explicit
 * write-after-listen / clear-on-shutdown pairing (kept verbatim in step 9).
 */
export class Session extends Context.Service<Session, {
  /** Write/overwrite the session file for `info.repoRoot`. */
  write(info: SessionInfo): Effect.Effect<void, SessionError>;
  /** Read the session file; `null` when missing or unreadable (matches the
   *  free function's tolerance of stale/corrupt files). */
  read(repoRoot: string): Effect.Effect<SessionInfo | null>;
  /** Remove the session file; succeeds even when it is already gone. */
  clear(repoRoot: string): Effect.Effect<void>;
}>()("diffreview/server/Session") {
  static readonly layer = Layer.effect(
    Session,
    Effect.gen(function*() {
      // Serialize write/clear pairs so a shutdown race can't interleave a
      // re-write between clear and process exit.
      const sema = yield* Semaphore.make(1);

      return Session.of({
        write: (info) =>
          sema.withPermits(1)(
            Effect.try({
              try: () => writeSession(info),
              catch: (cause) => ({ op: "write", cause }) as unknown as SessionError
            })
          ),
        read: (repoRoot) => Effect.sync(() => readSession(repoRoot)),
        // clearSession already tolerates missing files (swallows fs errors).
        clear: (repoRoot) =>
          sema.withPermits(1)(Effect.sync(() => clearSession(repoRoot)))
      });
    })
  );
}

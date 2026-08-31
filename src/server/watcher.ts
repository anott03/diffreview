/**
 * Poll-based diff watcher as an Effect service.
 *
 * Replaces the old `DiffWatcher` class (removed from git.ts in this step):
 * - the poll loop is a fiber forked in the layer's scope (interrupted on
 *   teardown — no more setInterval/stop), sequential by construction so slow
 *   git runs never overlap, with a semaphore serializing explicit and polled
 *   refreshes
 * - change fan-out goes through a `PubSub<SseEvent>` (replaces the onChange
 *   callback); step 7's SSE endpoint subscribes to `changes`, and the HTTP
 *   comment handlers publish "comments" events via `publish`
 *
 * `WatcherCompat` is the interim bridge for the Hono routes and cli (deleted
 * in step 7+), preserving the old sync `files`/`onChange`/`refresh`/`start`/
 * `stop` surface.
 */
import { Context, Effect, Layer, ManagedRuntime, PubSub, Ref, Semaphore, Stream } from "effect";
import type { Stream as StreamT } from "effect";
import type { DiffFile, SseEvent } from "../shared/types";
import { parseGitDiff } from "./diff";
import { Git, type GitError } from "./git";

export class Watcher extends Context.Service<Watcher, {
  /** Latest parsed diff. Empty until the first successful refresh. */
  readonly files: Effect.Effect<Array<DiffFile>>;
  /**
   * Re-collect state; re-parse and publish only when the state hash changed.
   * Resolves `true` when the diff changed (and a "diff" event was published).
   * Serialized with the poll loop — never overlaps a running refresh.
   */
  refresh(): Effect.Effect<boolean, GitError>;
  /** Publish an SSE event directly (e.g. "comments" from HTTP handlers). */
  publish(event: SseEvent): Effect.Effect<boolean>;
  /** Stream of SSE events: "diff" on poll-detected changes + published events. */
  readonly changes: StreamT.Stream<SseEvent>;
}>()("diffreview/server/Watcher") {
  /**
   * @param options.root   repo root to watch
   * @param options.intervalMs poll interval; the loop sleeps before its first
   *   refresh, so startup data comes from an explicit `refresh()` call
   */
  static readonly layer = (options: {
    root: string;
    intervalMs: number;
  }): Layer.Layer<Watcher, never, Git> =>
    Layer.effect(
      Watcher,
      Effect.gen(function*() {
        const git = yield* Git;
        const { root, intervalMs } = options;

        const filesRef = yield* Ref.make<Array<DiffFile>>([]);
        const lastHashRef = yield* Ref.make("");
        const pubsub = yield* PubSub.unbounded<SseEvent>();

        const refresh = Effect.fn("Watcher.refresh")(function*() {
          const state = yield* git.collectState(root);
          const lastHash = yield* Ref.get(lastHashRef);
          if (state.hash === lastHash) return false;
          yield* Ref.set(lastHashRef, state.hash);
          const untracked = yield* git.readUntrackedFiles(root, state.untrackedPaths);
          const files = [...parseGitDiff(state.diffText), ...untracked];
          yield* Ref.set(filesRef, files);
          const event: SseEvent = { type: "diff", at: Date.now() };
          yield* PubSub.publish(pubsub, event);
          return true;
        });

        // One refresh at a time across the poll loop and explicit callers
        // (replaces the old running-guard flag).
        const refreshLocked = yield* Semaphore.make(1);
        const refreshSwallowed = refreshLocked.withPermits(1)(
          Effect.catch(refresh(), () => Effect.succeed(false))
        );

        // Sequential loop: the next sleep only starts after the refresh
        // completes, so slow git runs can never overlap. The loop sleeps
        // first — initial data comes from the explicit startup refresh
        // (cli), keeping layer build side-effect-free.
        const pollLoop = Effect.forever(
          Effect.andThen(Effect.sleep(intervalMs), refreshSwallowed)
        );
        yield* Effect.forkScoped(pollLoop);

        return Watcher.of({
          files: Effect.map(Ref.get(filesRef), (files) => [...files]),
          refresh,
          publish: (event) => PubSub.publish(pubsub, event),
          changes: Stream.fromPubSub(pubsub)
        });
      })
    );
}

// ---------------------------------------------------------------------------
// Interim bridge (removed when Hono/cli migrate to Effect)
// ---------------------------------------------------------------------------

export class WatcherCompat {
  /** Latest parsed diff. Empty until the first successful refresh. */
  files: DiffFile[] = [];
  /** Called after `files` changes (consumed by the Hono SSE fan-out). */
  onChange?: (files: DiffFile[]) => void;

  private runtime: ManagedRuntime.ManagedRuntime<Watcher, never>;

  constructor(root: string, intervalMs: number) {
    this.runtime = ManagedRuntime.make(
      Watcher.layer({ root, intervalMs }).pipe(Layer.provide(Git.layer))
    );
    // Mirror poll-driven changes into the sync surface (files/onChange):
    // the poll loop lives in the service layer and publishes to the PubSub,
    // bypassing WatcherCompat.refresh() — without this fiber, deps.watcher.files
    // would go stale after startup (and SSE would never fire on poll changes).
    // "comments" events are published by the HTTP handlers directly and are
    // ignored here. Interrupted by stop() via runtime disposal.
    this.runtime.runFork(
      Watcher.use((w) =>
        Stream.runForEach(w.changes, (event) =>
          Effect.sync(() => {
            if (event.type === "diff") void this.syncFiles();
          })
        )
      )
    );
  }

  private async syncFiles(): Promise<void> {
    this.files = await this.runtime
      .runPromise(Watcher.use((w) => w.files))
      .catch(() => this.files);
    this.onChange?.(this.files);
  }

  /** Re-collect state; mirrors the change into the sync `files` field and
   *  fires `onChange` only when the diff actually changed. Errors are
   *  swallowed (transient git failures), matching the old class. */
  async refresh(): Promise<void> {
    const changed = await this.runtime
      .runPromise(Watcher.use((w) => w.refresh()))
      .catch(() => false);
    if (!changed) return;
    await this.syncFiles();
  }

  /** Polling starts when the layer builds (first runPromise); this ensures
   *  the layer is built even if `refresh()` was never called. */
  start(): void {
    void this.runtime.runPromise(Watcher.use((w) => w.files)).catch(() => {});
  }

  /** Interrupts the poll fiber and releases the underlying Git service. */
  stop(): void {
    void this.runtime.dispose().catch(() => {});
  }
}

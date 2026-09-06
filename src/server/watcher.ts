/**
 * Poll-based diff watcher as an Effect service.
 *
 * Replaces the old `DiffWatcher` class:
 * - the poll loop is a fiber forked in the layer's scope (interrupted on
 *   teardown — no more setInterval/stop), sequential by construction so slow
 *   git runs never overlap, with a semaphore serializing explicit and polled
 *   refreshes
 * - change fan-out goes through a `PubSub<SseEvent>` (replaces the onChange
 *   callback); the SSE endpoint subscribes to `changes`, and the HTTP
 *   comment handlers publish "comments" events via `publish`
 *
 */
import { Context, Effect, Layer, PubSub, Ref, Semaphore, Stream } from "effect";
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
          // Expose the semaphore-guarded refresh so explicit callers (e.g. the
          // cli's startup refresh) serialize with the poll loop too.
          refresh: () => refreshLocked.withPermits(1)(refresh()),
          publish: (event) => PubSub.publish(pubsub, event),
          changes: Stream.fromPubSub(pubsub)
        });
      })
    );
}

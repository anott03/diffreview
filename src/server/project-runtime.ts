import { Context, Effect, Layer } from "effect";
import { ProjectConfig, type ProjectOptions } from "./config";
import { ProjectReview } from "./project-review";
import { CommentStore } from "./store";
import { Watcher } from "./watcher";

export const makeProjectRuntime = (options: ProjectOptions) => Effect.gen(function*() {
  const core = CommentStore.layer(options.dbPath);
  const services = Watcher.layer({ root: options.repoRoot, intervalMs: options.intervalMs }).pipe(
    Layer.provideMerge(core),
    Layer.merge(Layer.succeed(ProjectConfig, options))
  );
  const context = yield* Layer.build(ProjectReview.layer.pipe(Layer.provideMerge(services)));
  const watcher = Context.get(context, Watcher);
  yield* watcher.refresh();
  return {
    review: Context.get(context, ProjectReview),
    watcher
  };
});

export type ProjectRuntime = Effect.Success<ReturnType<typeof makeProjectRuntime>>;

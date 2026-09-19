import { Cause, Context, Deferred, Effect, Exit, Layer, Option, PubSub, Scope, Stream } from "effect";
import type { Project, SseEvent } from "../shared/types";
import { BadRequestError, InternalError, NotFoundError, ProjectUnavailableError } from "./api";
import { ServerConfig } from "./config";
import { errMessage } from "./error-message";
import { Git } from "./git";
import { ProjectCatalog, type CatalogEntry } from "./project-catalog";
import { resolveProjectPath } from "./project-path";
import { makeProjectRuntime, type ProjectRuntime } from "./project-runtime";

type RegistryError = InternalError | NotFoundError | ProjectUnavailableError;

export class ProjectRegistry extends Context.Service<ProjectRegistry, {
  readonly projects: Effect.Effect<Project[], InternalError>;
  readonly changes: Stream.Stream<SseEvent>;
  open(path: string): Effect.Effect<Project, RegistryError | BadRequestError>;
  get(id: string): Effect.Effect<ProjectRuntime, RegistryError>;
}>()("diffreview/server/ProjectRegistry") {
  static readonly layer = Layer.effect(ProjectRegistry, Effect.gen(function*() {
    const catalog = yield* ProjectCatalog;
    const config = yield* ServerConfig;
    const git = yield* Git;
    const serverScope = yield* Effect.scope;
    const events = yield* PubSub.unbounded<SseEvent>();
    yield* Effect.addFinalizer(() => PubSub.shutdown(events));
    const loaded = new Map<string, Deferred.Deferred<ProjectRuntime, ProjectUnavailableError>>();

    const load = Effect.fn("ProjectRegistry.load")(function*(entry: CatalogEntry) {
      const { project, dbPath } = entry;
      const canonical = yield* Effect.tryPromise({
        try: () => resolveProjectPath(project.root),
        catch: (cause) => new ProjectUnavailableError({ error: errMessage(cause) })
      });
      if (canonical !== project.root) {
        return yield* Effect.fail(new ProjectUnavailableError({
          error: `Project working tree changed location: ${project.root}. Register its new path explicitly.`
        }));
      }
      const pending = yield* Effect.uninterruptible(Effect.gen(function*() {
        const { deferred, initializeRuntime } = yield* Effect.sync(() => {
          const existing = loaded.get(project.id);
          if (existing) return { deferred: existing, initializeRuntime: false };
          const deferred = Deferred.makeUnsafe<ProjectRuntime, ProjectUnavailableError>();
          loaded.set(project.id, deferred);
          return { deferred, initializeRuntime: true };
        });
        if (!initializeRuntime) return deferred;
        const initialize = Effect.gen(function*() {
          yield* catalog.validateDatabase(entry);
          const scope = yield* Scope.fork(serverScope, "sequential");
          return yield* makeProjectRuntime({
            projectId: project.id,
            repoRoot: project.root,
            dbPath,
            intervalMs: config.intervalMs
          }).pipe(
            Effect.provideService(Git, git),
            Scope.provide(scope),
            Effect.tap((runtime) => runtime.watcher.changes.pipe(
              Stream.runForEach((event) => PubSub.publish(events, { ...event, projectId: project.id })),
              Effect.forkIn(scope, { startImmediately: true })
            )),
            Effect.tap(() => catalog.recordDatabase(entry)),
            Effect.onExit((exit) => Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void)
          );
        }).pipe(
          Effect.catchCause((cause) => {
            const failure = Cause.findErrorOption(cause);
            const message = Option.isSome(failure) && (failure.value instanceof ProjectUnavailableError || failure.value instanceof InternalError)
              ? failure.value.error
              : Cause.pretty(cause);
            return Effect.fail(new ProjectUnavailableError({ error: `Cannot load project ${project.root}: ${message}` }));
          }),
          Effect.onExit((exit) => Effect.gen(function*() {
            if (Exit.isFailure(exit)) loaded.delete(project.id);
            yield* Deferred.done(deferred, exit);
          }))
        );
        yield* Effect.forkIn(Effect.interruptible(initialize), serverScope);
        return deferred;
      }));
      return yield* Deferred.await(pending);
    });

    const get = Effect.fn("ProjectRegistry.get")(function*(id: string) {
      const entry = yield* catalog.get(id);
      if (!entry) return yield* Effect.fail(new NotFoundError({ error: `Unknown project: ${id}` }));
      return yield* load(entry);
    });

    return ProjectRegistry.of({
      projects: catalog.list,
      changes: Stream.fromPubSub(events),
      get,
      open: Effect.fn("ProjectRegistry.open")(function*(path: string) {
        const root = yield* Effect.tryPromise({
          try: () => resolveProjectPath(path),
          catch: (cause) => new BadRequestError({ error: errMessage(cause) })
        });
        const project = yield* catalog.register(root, path);
        yield* PubSub.publish(events, { type: "projects", at: Date.now() });
        yield* get(project.id);
        return project;
      })
    });
  }));
}

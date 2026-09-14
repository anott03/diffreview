import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Context, Effect, Layer, Schema, Semaphore } from "effect";
import type { Project } from "../shared/types";
import { ProjectSchema } from "./api-schemas";
import { InternalError, ProjectUnavailableError } from "./api";
import { errMessage } from "./error-message";
import { dataDir, projectCatalogPath, repoHash } from "./paths";
import { resolveProjectPath } from "./project-path";

const CatalogEntrySchema = Schema.Struct({ project: ProjectSchema, dbPath: Schema.String });
const ProjectRowSchema = Schema.Struct({
  id: Schema.String, root: Schema.String, name: Schema.String, openedAt: Schema.Number, dbPath: Schema.String,
  dbInitialized: Schema.Number
});
const decodeRows = Schema.decodeUnknownSync(Schema.Array(ProjectRowSchema));
const LegacySessionSchema = Schema.fromJsonString(Schema.Struct({ repoRoot: Schema.String }));

export type CatalogEntry = typeof CatalogEntrySchema.Type;

async function databaseForRoot(root: string, input: string, directory: string, previous?: string, requireExisting = false): Promise<string> {
  const candidates = new Set<string>([join(directory, `${repoHash(root)}.sqlite`)]);
  if (previous) candidates.add(previous);
  let ancestor = resolve(input);
  while (true) {
    if (await realpath(ancestor).catch(() => null) === root) {
      candidates.add(join(directory, `${repoHash(ancestor)}.sqlite`));
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const sessions = join(directory, "sessions");
  for (const file of await readdir(sessions).catch(() => [])) {
    if (!file.endsWith(".json")) continue;
    try {
      const session = Schema.decodeUnknownSync(LegacySessionSchema)(await readFile(join(sessions, file), "utf8"));
      if (await resolveProjectPath(session.repoRoot) === root) {
        candidates.add(join(directory, `${repoHash(session.repoRoot)}.sqlite`));
      }
    } catch {
      continue;
    }
  }
  const existing = [...candidates].filter((path) => existsSync(path));
  if (existing.length > 1) {
    throw new Error(`Multiple comment databases resolve to ${root}: ${existing.join(", ")}. Stop old servers and reconcile these databases before opening this project.`);
  }
  if (previous && existing[0] && existing[0] !== previous) {
    throw new Error(`The catalogued comment database ${previous} is missing, but ${existing[0]} exists. Restore or reconcile the databases before opening ${root}.`);
  }
  if (requireExisting && previous && !existsSync(previous)) {
    throw new Error(`The catalogued comment database ${previous} is missing. Restore it before opening ${root}; a replacement database will not be created.`);
  }
  return existing[0] ?? previous ?? join(directory, `${repoHash(root)}.sqlite`);
}

export class ProjectCatalog extends Context.Service<ProjectCatalog, {
  readonly list: Effect.Effect<Project[], InternalError>;
  get(id: string): Effect.Effect<CatalogEntry | undefined, InternalError>;
  validateDatabase(entry: CatalogEntry): Effect.Effect<void, InternalError | ProjectUnavailableError>;
  recordDatabase(entry: CatalogEntry): Effect.Effect<void, InternalError>;
  register(root: string, input: string): Effect.Effect<Project, InternalError | ProjectUnavailableError>;
}>()("diffreview/server/ProjectCatalog") {
  static readonly layer = (path = projectCatalogPath()) => Layer.effect(ProjectCatalog, Effect.gen(function*() {
    const db = yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          mkdirSync(dirname(path), { recursive: true });
          const opened = new DatabaseSync(path);
          try {
            opened.exec(`
              PRAGMA journal_mode = WAL;
              CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                root TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                openedAt INTEGER NOT NULL,
                dbPath TEXT NOT NULL UNIQUE,
                dbInitialized INTEGER NOT NULL DEFAULT 1
              );
            `);
            const columns = opened.prepare("PRAGMA table_info(projects)").all();
            if (!columns.some((column) => column.name === "dbInitialized")) {
              opened.exec("ALTER TABLE projects ADD COLUMN dbInitialized INTEGER NOT NULL DEFAULT 1");
            }
            return opened;
          } catch (cause) {
            opened.close();
            throw cause;
          }
        },
        catch: (cause) => new InternalError({ error: `Cannot open project catalog: ${errMessage(cause)}` })
      }),
      (opened) => Effect.sync(() => opened.close())
    );
    const registration = yield* Semaphore.make(1);
    const directory = path === ":memory:" ? dataDir() : dirname(path);
    const rows = () => decodeRows(db.prepare("SELECT * FROM projects ORDER BY openedAt DESC, id").all());
    const toProject = ({ id, root, name, openedAt }: typeof ProjectRowSchema.Type): Project => ({ id, root, name, openedAt });
    const get = (id: string) => Effect.try({
      try: () => {
        const row = rows().find((project) => project.id === id);
        return row ? { project: toProject(row), dbPath: row.dbPath } : undefined;
      },
      catch: (cause) => new InternalError({ error: errMessage(cause) })
    });
    const recordDatabase = (entry: CatalogEntry) => Effect.try({
      try: () => {
        if (existsSync(entry.dbPath)) {
          db.prepare("UPDATE projects SET dbInitialized = 1 WHERE id = ? AND dbPath = ?").run(entry.project.id, entry.dbPath);
        }
      },
      catch: (cause) => new InternalError({ error: errMessage(cause) })
    });
    return ProjectCatalog.of({
      list: Effect.try({ try: () => rows().map(toProject), catch: (cause) => new InternalError({ error: errMessage(cause) }) }),
      get,
      recordDatabase,
      validateDatabase: (entry) => registration.withPermits(1)(Effect.gen(function*() {
        const row = yield* Effect.try({
          try: () => rows().find((project) => project.id === entry.project.id),
          catch: (cause) => new InternalError({ error: errMessage(cause) })
        });
        if (!row || row.root !== entry.project.root || row.dbPath !== entry.dbPath) {
          return yield* Effect.fail(new ProjectUnavailableError({ error: `The catalogued database mapping for ${entry.project.root} changed. Retry opening this project.` }));
        }
        yield* Effect.tryPromise({
          try: () => databaseForRoot(row.root, row.root, directory, row.dbPath, row.dbInitialized !== 0),
          catch: (cause) => new ProjectUnavailableError({ error: errMessage(cause) })
        });
        yield* recordDatabase(entry);
      })),
      register: (root, input) => registration.withPermits(1)(Effect.gen(function*() {
        const id = repoHash(root);
        const previous = yield* Effect.try({
          try: () => rows().find((project) => project.id === id),
          catch: (cause) => new InternalError({ error: errMessage(cause) })
        });
        if (previous && previous.root !== root) {
          return yield* Effect.fail(new ProjectUnavailableError({ error: `Project identity collision for ${root}` }));
        }
        const dbPath = yield* Effect.tryPromise({
          try: () => databaseForRoot(root, input, directory, previous?.dbPath, previous?.dbInitialized !== 0 && previous !== undefined),
          catch: (cause) => new ProjectUnavailableError({ error: errMessage(cause) })
        });
        const project: Project = { id, root, name: basename(root), openedAt: Date.now() };
        yield* Effect.try({
          try: () => db.prepare(`
            INSERT INTO projects (id, root, name, openedAt, dbPath, dbInitialized) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET openedAt = excluded.openedAt,
              dbInitialized = MAX(projects.dbInitialized, excluded.dbInitialized)
          `).run(id, root, project.name, project.openedAt, dbPath, existsSync(dbPath) ? 1 : 0),
          catch: (cause) => new InternalError({ error: errMessage(cause) })
        });
        return project;
      }))
    });
  }));
}

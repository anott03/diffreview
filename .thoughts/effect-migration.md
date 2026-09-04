# Migrating diffreview's server to Effect v4 (beta)

Status: **in progress** — steps 0–4 done (see per-step checklists below).
Scope: `src/server/` only. `src/mcp/` and `src/web/` are out of scope for this
migration round; they are HTTP clients of the server and their contracts
(`src/shared/types.ts`) must not change.

> **Naming note (step 4):** the Effect service owns the `CommentStore` name;
> the legacy synchronous class was renamed `CommentStoreCompat` and is deleted
> in step 7+. Same pattern as the step-3 bridge, adapted for the class-name
> collision.

---

## 1. Context

diffreview currently has **zero Effect dependencies**. The server is:

- **HTTP**: `hono` + `@hono/node-server` (REST routes, SSE via `hono/streaming`,
  static file serving via `@hono/node-server/serve-static`)
- **Validation**: `zod` (server-side only; `src/shared/types.ts` is plain TS)
- **Services**: plain classes (`CommentStore`, `DiffWatcher`), free functions
  for git, promisified `node:child_process` for git commands
- **Storage**: `node:sqlite` (`DatabaseSync`) — deliberate choice, keep it
  (do **not** swap to `@effect/sql-*`; those use better-sqlite3/libsql drivers)
- **Lifecycle**: manual `shutdown()` wired to `process.on("exit"/"SIGINT"/"SIGTERM")`
  in `cli.ts`, `setInterval`-based polling in `DiffWatcher`

Decision (confirmed with user): **full Effect-native HTTP** — replace Hono with
`HttpApi` from `effect/unstable/httpapi`, served by `@effect/platform-node`.

## 2. Goals

1. Server domain logic expressed as Effect services (`Context.Service` + `Layer`)
   with typed, tagged errors.
2. HTTP API defined with Effect `Schema` (replacing zod) and served via
   `effect/unstable/httpapi` + `NodeHttpServer`.
3. Lifecycle (watcher polling, SSE fan-out, DB open/close, session files,
   signal handling) managed by Effect scopes/finalizers instead of manual code.
4. All existing behavior preserved byte-for-byte where observable:
   - same REST routes, status codes, JSON shapes (`src/shared/types.ts`)
   - same SSE event format (`{ type: "diff" | "comments", at }`, 30s pings)
   - same session file location/format (MCP discovery depends on it)
   - same comment anchoring semantics (`resolveAnchors` untouched)
   - same startup banner, CLI flags, `--open`, exit codes
5. Tests migrated to `@effect/vitest`; `pnpm typecheck && pnpm test && pnpm build`
   green at every commit checkpoint.

## 3. Dependency changes

```bash
pnpm add effect@beta @effect/platform-node@beta @effect/vitest@beta
pnpm remove zod hono @hono/node-server
```

- Pin the **exact same beta version** for all three (v4 has unified versioning,
  but pin explicitly since beta APIs may break between releases). E.g. if
  `effect@4.0.0-beta.N` installs, set all three to `4.0.0-beta.N` in package.json.
- `engines` (node >=24) is fine — Effect v4 needs >=23/24-era Node.
- esbuild bundling flags in `build:server` stay as-is (`--packages=external`).

## 4. Key API mapping (v4)

| Current (non-Effect)              | Effect v4 target                                                        |
| --------------------------------- | ----------------------------------------------------------------------- |
| plain class + `new` in cli.ts     | `Context.Service` (class with `Key`/`make` via `Context.Service.make`?) — *verify exact v4 service declaration pattern against `MIGRATION/migration/services.md` at implementation time* |
| manual wiring / constructor args  | `Layer`s, composed into a single `MainLive`                              |
| `zod.object(...)`                 | `Schema` classes/structs (v4 Schema is rewritten — follow `packages/effect/SCHEMA.md` guide; import path may be `effect/Schema` or `effect/unstable/schema` — verify) |
| Hono routes + `c.json()`          | `HttpApi.make` / `HttpApiGroup` / `HttpApiEndpoint` with Schema-typed payloads |
| `@hono/node-server` `serve()`     | `NodeHttpServer` from `@effect/platform-node`                            |
| `app.onError`                     | typed error channels on endpoints + `HttpApiBuilder` error handling      |
| `streamSSE` (hono)                | `HttpServerResponse` streaming a `Stream` from a `PubSub`                |
| `setInterval` polling             | fiber: `Effect.forever` + `Effect.sleep` (or `Effect.repeat` w/ schedule)|
| `onChange` callback               | `PubSub` published by the Watcher service                                |
| manual `shutdown()`               | `Layer.acquireRelease` finalizers + scope close on signals               |
| `process.on("SIGINT")`            | `NodeRuntime.runMain` (handles signals/teardown) — *verify v4 name*      |
| `promisify(execFile)`             | `Effect.try` around `execFile` (or `Effect.promise`), tagged errors      |
| `try/catch` error strings         | tagged error types: `NotARepoError`, `GitError`, `CommentNotFoundError`  |

> ⚠️ The v3→v4 docs are still settling; several exact signatures above
> (`Context.Service` declaration form, `NodeRuntime` entry point, Schema import
> path, `HttpApiEndpoint` builder shape) must be confirmed against the beta
> sources under `node_modules/effect` + `node_modules/@effect/platform-node`
> and the two official guides before writing code:
> - https://github.com/Effect-TS/effect/blob/main/MIGRATION.md
> - https://github.com/Effect-TS/effect/blob/main/packages/effect/SCHEMA.md

## 5. Step-by-step execution

Each numbered step is one commit checkpoint; `pnpm typecheck && pnpm test` must
pass (or the failing old tests are migrated in the same step). Interim
checkpoints 2–5 keep Hono running, bridged to Effect via `Effect.provide` +
`Effect.runPromise`, so the server stays functional throughout — the HTTP swap
(6–7) is the only "big bang" and lands in a single commit.

### Step 0 — Baseline (DONE — see Appendix A)

- [x] Record baseline: `pnpm typecheck && pnpm test && pnpm build` all green.
- [x] Smoke test `pnpm dev:server` + UI + a manual MCP curl to `/api/comments`
      so we can diff behavior later.

### Step 1 — Install beta deps (DONE — see Appendix B)

- [x] `pnpm add effect@beta @effect/platform-node@beta @effect/vitest@beta`.
- [x] Pin identical beta versions in `package.json` (see §3).
- [x] Confirm `pnpm typecheck` still green (nothing imports Effect yet).
- [x] Skim installed sources to pin down the v4 API facts flagged in §4:
      service declaration pattern, Schema import path, `HttpApi*` builder
      signatures, `NodeHttpServer`/`NodeRuntime` exports. Write findings into
      this file (appendix) before proceeding.

### Step 2 — Schema layer (server-side, replaces zod) (DONE — awaiting review)

New file: `src/server/api-schemas.ts`; tests in `src/server/api-schemas.test.ts`.

- [x] `Schema` equivalents for all server-owned contracts: `CreateCommentRequest`,
      `UpdateCommentRequest` (incl. the "empty patch" filter via
      `Schema.makeFilter`), `Comment`, `DiffFile`/`DiffHunk`/`DiffLine`, `Meta`,
      response wrappers, `ApiErrorResponse`, `SseEvent`.
- [x] `src/shared/types.ts` untouched; parity enforced by a type-level test:
      mutual-assignability assertions for struct schemas + strict `Equal` for
      the literal unions. (Token-level `Equal` proved too brittle for nested
      struct optionality — arrays are wrapped in `Schema.mutable` so decoded
      types use mutable arrays like the shared interfaces.)
- [x] `PositiveIntSchema` = `Schema.Finite` + `isInt` + `isGreaterThan(0)`
      (matches zod `int().positive()`).
- [x] Optional keys use `Schema.optionalKey` (exact-optional) — matches the
      conditional-spread emission in `store.rowToComment`/`resolveAnchors`.
- [x] Runtime tests: decode/encode round-trips, note/outdated presence vs
      absence in JSON (Hono parity: absent keys stay absent, present-false
      stays present), invalid enums/lines/empty patches rejected.
- [x] 17 new tests; 48 total green; typecheck green. No existing code touched.
- [ ] Commit (waiting for review).

Note: HttpApi will layer status-code annotations (`HttpApiSchema.status(201)`
etc.) onto these schemas in Step 7 — kept out of this file so it stays a pure
contract mirror of shared/types.ts.

### Step 3 — `Git` service (DONE — committed as 84b67cb)

Rewrote `src/server/git.ts` (DiffWatcher kept, bridge-connected).

- [x] `Git extends Context.Service` ("diffreview/server/Git") with methods:
      `run`, `getRepoRoot`, `hasHead`, `getMeta`, `trackedDiffText`,
      `listUntracked`, `readUntrackedFiles`, `collectState`, `getDiffFiles`.
      Static `Git.layer` = `Layer.effect`.
- [x] Tagged errors: `GitError { args, cause }`, `NotARepoError { cwd }` via
      `Schema.TaggedError` (`cause: Schema.Defect()`).
- [x] `execFile` wrapped with `Effect.tryPromise` (64MB maxBuffer preserved);
      concurrent calls via `Effect.all(..., { concurrency: "unbounded" })`
      mirroring the old `Promise.all` fan-outs.
- [x] Vanished-file races surface as `null` results (catch → success channel),
      preserving the old skip-on-error behavior for untracked reads.
- [x] Interface note: `getMeta` is declared `Effect<Meta, GitError>` — more
      precise than the old signature (its `rev-parse HEAD` could already
      throw; Hono's onError turned that into a 500, unchanged).
- [x] Interim bridge: module-level `ManagedRuntime.make(Git.layer)`;
      old exports (`git`, `getRepoRoot`, `hasHead`, `getMeta`, `getDiffFiles`)
      delegate via `Git.use(...)` + `runPromise`.
      `getRepoRoot` maps `NotARepoError` back to the legacy
      `Error("not a git repository: <cwd>")` that cli.ts prints.
- [x] `DiffWatcher.refresh` now calls the bridge (`collectStateBridge`,
      `readUntrackedFilesBridge`); class otherwise unchanged (step 5).
- [x] +2 tests (canonical root; legacy non-repo error message). 50 total
      green; typecheck green.
- [x] Smoke test: server starts, `/api/meta` byte-identical to baseline,
      comments CRUD + 204/404 paths fine, SSE events fire, non-repo CLI
      message unchanged.
- [x] Committed as 84b67cb.

### Step 4 — `CommentStore` service (DONE — awaiting review)

Rewrote `src/server/store.ts`. Three layers in one file:

- [x] Sync core functions (`openDatabaseSync`, `listComments`, `getComment`,
      `insertComment`, `updateComment`, `removeComment`) — single source of
      truth for SQL + row mapping, shared by both implementations.
- [x] `CommentStore` Effect service ("diffreview/server/CommentStore") with
      `list`/`get`/`create`/`update`/`remove` returning
      `Effect<_, StoreError>`; identical SQL and row mapping.
      `StoreError { op, cause }` via `Schema.TaggedError`
      (`op: Literals(["open","list","get","create","update","remove"])`).
- [x] Lifecycle: `Layer.effect` + `Effect.acquireRelease` — open (mkdir +
      `new DatabaseSync` + schema exec) on acquire, `db.close()` swallowed on
      release. Deviation from plan wording: v4 has no `Layer.scoped`;
      `Layer.effect` runs its effect in the layer's scope, which is the v4
      acquireRelease pattern. The manual `close()` call in cli.ts disappears
      in step 9.
- [x] `":memory:"` special case kept (inside shared `openDatabaseSync`).
- [x] Interim bridge: legacy class **renamed** `CommentStoreCompat` (the
      service now owns the `CommentStore` name per plan); same sync behavior,
      delegates to the core. Import-site updates: `cli.ts` (2), `index.ts` (2).
      Deleted in step 7+.
- [x] Tests: `store.test.ts` rewritten against the service using
      `@effect/vitest` (`it.effect` + `Effect.provide(layer)`); same six
      cases as the legacy tests plus two new ones — reopen across two layer
      builds, and `StoreError(op=open)` via `Effect.flip` on an unopenable
      path. Legacy-class tests intentionally dropped: the class is a thin
      delegate over the same core the service exercises.
- [x] 52 tests green; typecheck green; no runtime behavior change (server
      still runs on `CommentStoreCompat`).
- [ ] Commit (waiting for review).

### Step 5 — `Watcher` service (replaces `DiffWatcher`)

Rewrite the polling half of `src/server/git.ts` into its own module
(`src/server/watcher.ts`):

- [ ] `Watcher` service with:
      - `filesRef`: current `DiffFile[]` (an `Effect.Ref` or plain ref inside
        the service state) — replaces the `files` property
      - `changes`: a `PubSub<SseEvent>`-shaped publish/subscribe used by SSE
        (replaces `onChange` callback)
      - `refresh(): Effect<void>` — same hash-based change detection
      - `pollLoop`: `Effect.forever(Effect.sleep(intervalMs) *> refresh.catchAll(...))`
        preserving "never overlap slow git runs" (use a running-guard ref or
        rely on sequential loop semantics)
- [ ] Layer `acquireRelease`: acquire forks the poll fiber, release interrupts
      it (replaces `start()`/`stop()`/`clearInterval`).
- [ ] Interim bridge: `watcher.onChange` equivalent implemented by publishing
      to the PubSub + a subscribe-side callback for the old Hono SSE code.
- [ ] Migrate `git.test.ts` watcher tests to the new service.

### Step 6 — `Session` service + `Config` (DONE — awaiting review)

- [x] `paths.ts` untouched (pure functions).
- [x] `session.ts`: free functions kept verbatim as the interim bridge
      (mcp discovery + cli still call them); added `Session` service
      (write/read/clear, Semaphore-serialized write/clear, read returns null
      on missing/corrupt like today; no auto-clear on layer release — the cli
      owns the explicit write/clear pairing, kept verbatim in step 9).
- [x] `session.test.ts`: 6 service tests + free-function bridge parity test
      (XDG_DATA_HOME pointed at a tmpdir).
- [x] `ServerConfig` service (repoRoot, port, intervalMs, open, dbPath,
      webRoot) — provided via `Layer.succeed` at composition. NOTE: the
      earlier step-6 summary wrongly claimed config.ts existed; it was
      actually created during step 7 (handlers consume repoRoot).

### Step 7 — HTTP layer: HttpApi definition (DONE — awaiting review)

New file: `src/server/api.ts`. Deviations from the plan, driven by v4 behavior
discovered empirically (see http.test.ts):

- Error payloads are TaggedError classes (`_tag` + `error` fields) with
  HttpApiSchema.status annotations. Plain `{error}` structs with different
  status annotations are indistinguishable to the union encoder — it always
  matches the FIRST member (empirically produced 404/500 for bad payloads).
  Wire body: `{"_tag":"BadRequestError","error":"..."}` — clients read
  `.error`; extra `_tag` is a harmless wire difference.
- POST/PATCH/DELETE use handleRaw with manual `HttpServerRequest.schemaBodyJson`
  decoding so invalid payloads render 400 `{ error: "<message>" }` (declared
  HttpApi payloads render an EMPTY 400 via HttpApiSchemaError).
- `/api/events` is a group endpoint with `HttpApiSchema.StreamSse` (events
  mode) — no raw router route needed, and the handler shares the api
  handlers' Watcher instance (single PubSub).
- Unmatched `/api/*` → JSON 404 via a raw `HttpRouter.add("*", "/api/*")`
  layer (no service requirements — avoids Request-wrapped provide issues).


- [ ] `HttpApi` instance with one group ("api") and endpoints:
      - `GET /api/meta` → `Meta` schema
      - `GET /api/diff` → `GetDiffResponse`
      - `GET /api/comments` (query params `status`, `file`) → `ListCommentsResponse`
      - `POST /api/comments` (body: `CreateCommentRequest`) → `Comment`, 201
      - `PATCH /api/comments/:id` (body: `UpdateCommentRequest`) → `Comment` |
        `CommentNotFoundError` (404)
      - `DELETE /api/comments/:id` → 204 | `CommentNotFoundError` (404)
      - error payload `ApiErrorResponse` wired as the shared error schema; 400
        decode errors must render as `{ error: "<issues>" }` to preserve
        `zodError`-style messages for MCP/web clients.
- [ ] Preserve exact JSON shapes and status codes (201 create, 404 missing,
      204 delete, 400 invalid) — `src/mcp/client.ts` parses these.
- [ ] SSE: implement `GET /api/events` as a raw streaming response alongside
      the HttpApi (v4 HttpApi may not model SSE endpoints directly — verify;
      fall back to mounting a plain `HttpServerResponse` stream route):
      `Stream.fromPubSub(changes)` mapped to `event: <type>\ndata: {...}` +
      a 30s ping merged via `Stream.merge(Stream.sleep(30s) ...)`; abort
      cleanup via stream scope (replaces `sseClients` Set + `clearInterval`).

### Step 8 — HTTP layer: server composition (DONE — awaiting review)

New file: `src/server/http.ts` (+ integration tests in `http.test.ts`):

- [x] `HttpApiBuilder.group` handlers with Git/Watcher/CommentStore/ServerConfig
      in scope; `parseBody` helper for the raw decode-400 flow.
- [x] Re-anchor persistence logic moved verbatim into the listComments handler.
- [x] SSE handler: `watcher.changes` mapped to `{id, event, data}` frames +
      30s pings via `Stream.fromSchedule(Schedule.spaced)` (first ping is
      immediate vs 30s in the legacy loop — clients ignore pings).
- [x] Static serving: `HttpStaticServer.layer({root, spa: true, index})` when
      built (webRoot passed via ServerConfig); actionable 404 text route when
      not built. findWebRoot() stays in index.ts until step 9 moves it.
- [x] `serverLayer(options)`: `HttpRouter.serve(mergeAll(...))` +
      `NodeHttpServer.layer(createServer, {port, host: "127.0.0.1"})` +
      NodeFileSystem/NodePath + all domain services. NOTE: `Layer.provide([...])`
      does NOT resolve requirements BETWEEN array members — Watcher.layer must
      be pre-composed with `.pipe(Layer.provide(Git.layer))`.
- [x] Integration tests (toWebHandler, real git repo + :memory: store): meta
      shape, diff shape, CRUD statuses (201/200/204/404), invalid payloads
      400, invalid status query 400, unknown /api 404 JSON, unbuilt-UI 404
      text, SSE frame delivery. 70 tests green; typecheck + build green.
- [ ] cli.ts switch-over happens in step 9 (legacy server still live).


### Step 9 — Entry point (`cli.ts`) & MainLive

- [ ] Compose `MainLive = Config + Git + CommentStore(path) + Watcher(2s) + Session`.
- [ ] `main` program: validate args/port (same messages & exit codes) →
      resolve repoRoot (`NotARepoError` → `fail()` equivalent) → serve →
      `writeSession` → one synchronous `watcher.refresh` → banner logging →
      optional `xdg-open` spawn (`unref` preserved).
- [ ] Launch via `NodeRuntime.runMain(main.pipe(Effect.provide(MainLive)))`
      (or v4 equivalent — *verify*; v4 removed `Runtime<R>` and has automatic
      fiber keep-alive so a long-lived `serve` fiber keeps the process alive).
- [ ] SIGINT/SIGTERM: rely on runMain signal handling → scope finalizers close
      the HTTP server, interrupt poll fiber, close DB, clear session file.
      Verify session file is actually removed on Ctrl-C (MCP staleness
      tolerance makes this non-fatal, but preserve behavior).
- [ ] Keep the dynamic `await import("./store.js")`-style lazy DB loading only
      if trivially expressible in a Layer; otherwise drop the laziness (the
      `--help` fast path only needs it to stay silent — check timing).

### Step 10 — Delete legacy code & deps

- [ ] Remove `hono`, `@hono/node-server`, `zod` imports/files; delete old
      exports from `git.ts`/`store.ts`/`index.ts` replaced in 7–9.
- [ ] `pnpm remove zod hono @hono/node-server`.
- [ ] `AGENTS.md`: update architecture tree, conventions (Schema not zod,
      Layer-based services, no direct SQLite outside the store service), and
      pitfalls (drop Hono-specific notes; add Effect-beta pinning note).
- [ ] `README.md` if it mentions the stack.

### Step 11 — Tests

- [ ] Add `@effect/vitest`; convert `store.test.ts` (in-memory DB via test
      layer) and `git.test.ts` to `it.effect` / `it.scoped` with test layers.
- [ ] `diff.test.ts` unchanged (pure functions).
- [ ] Add a small integration test: start the HttpApi on an ephemeral port with
      a temp repo + in-memory store, hit `/api/meta`, `/api/comments` CRUD,
      assert JSON shapes and status codes (guards the MCP/web contract).
- [ ] Keep vitest config as-is (`include: src/**/*.test.ts`).

### Step 12 — Final verification

- [ ] `pnpm typecheck && pnpm test && pnpm build` green.
- [ ] Manual smoke: `pnpm dev:server` → UI at :5173, comments CRUD via UI,
      SSE invalidation on edit, `pnpm build && pnpm start` serves static UI,
      `diffreview-mcp` against the running server (discovery via session file).
- [ ] Verify SIGINT removes the session file and exits cleanly.
- [ ] Update this file: mark steps done, record any API deviations discovered
      (see §4 warning) into the appendix.

## 6. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Beta API drift (esp. `effect/unstable/httpapi`, Schema) | Pin exact beta versions; confirm signatures from installed sources before each phase (Step 1 findings appendix) |
| SSE/streaming subtleties in the new HTTP layer | Implement SSE first against a trivial PubSub in isolation; contract test with curl |
| JSON contract drift breaks web UI / MCP | Shared types untouched; Step 2 type-equality assertions; Step 11 integration test asserts exact shapes & status codes |
| Regression in shutdown/session cleanup | Explicit smoke check in Step 12; MCP tolerates stale files if it slips |
| `Runtime<R>` removal / keep-alive semantics differ from v3 docs | Follow MIGRATION.md; if runMain keeps process alive via long-lived fiber, no extra work; else fork daemon fiber explicitly |
| node:sqlite experimental warning | Unchanged behavior; document in AGENTS.md as before |

## 7. Out of scope (follow-ups)

- `src/mcp/` — could later adopt `effect/unstable/rpc` or stay as-is; it works
  unchanged over HTTP.
- `src/web/` — React/Kumo UI untouched; a later round could adopt
  `@effect/atom-react` for data fetching.
- `effect/unstable/cli` for arg parsing.
- Replacing `node:sqlite` with `@effect/sql-sqlite` (explicitly rejected for
  now — keep zero native deps).

## Appendix B — Step 1 v4 API findings (from installed `effect@4.0.0-beta.107`)

All facts below verified against `node_modules/effect/dist`,
`node_modules/effect/ai-docs/src` (official v4 doc fixtures shipped in the
package), and `node_modules/@effect/platform-node/dist`.

### Versions

`effect`, `@effect/platform-node`, `@effect/vitest` all installed at
**4.0.0-beta.107**, pinned exactly (no caret) in package.json.
`pnpm typecheck` green with deps installed (nothing imports them yet).

### Module layout

- `import { Effect, Context, Layer, Schema, Stream, PubSub, Config, ... } from "effect"`
  — **Schema is top-level in core** (not `effect/unstable/schema`; that export
  exists but core re-exports the working module — confirmed by AGENTS.md
  examples using `import { Effect, Schema } from "effect"`).
- HTTP primitives: `effect/unstable/http` (HttpRouter, HttpServerResponse,
  HttpStaticServer, FetchHttpClient, ...).
- HTTP API framework: `effect/unstable/httpapi` (HttpApi, HttpApiGroup,
  HttpApiEndpoint, HttpApiBuilder, HttpApiClient, HttpApiScalar, HttpApiError,
  HttpApiSchema).
- Platform: `@effect/platform-node` → `NodeHttpServer`, `NodeRuntime`,
  `NodeContext`, `NodeStream`.

### Service declaration (official idiom, from effect/AGENTS.md)

```ts
export class Database extends Context.Service<Database, {
  query(sql: string): Effect.Effect<Array<unknown>, DatabaseError>
}()>("myapp/db/Database") {
  static readonly layer = Layer.effect(
    Database,
    Effect.gen(function*() {
      const query = Effect.fn("Database.query")(function*(sql: string) { ... })
      return Database.of({ query })
    })
  )
}
export class DatabaseError extends Schema.TaggedError<DatabaseError>()(
  "DatabaseError", { cause: Schema.Defect() }
) {}
```

- Idiomatic code style per AGENTS.md: `Effect.gen` + `Effect.fn("name")`,
  **no `.pipe` inside `Effect.fn`** (pass combinators as extra args),
  `Effect.fn.Return<A, E>` for typed generator bodies.
- Errors: `Schema.TaggedError`; recover with `Effect.catch`, `Effect.catchTag`,
  `Effect.catchTags`, reason-based `Effect.catchReason(s)`.
- Long-running entrypoints: `Layer.launch` + `NodeRuntime.runMain` (runMain
  handles signals/teardown; optional `{ teardown }` override).
- PubSub is the documented fan-out primitive for event buses.

### HttpApi patterns (from ai-docs 51_http-server fixtures)

```ts
export class Api extends HttpApi.make("api").add(UsersApiGroup) {}

export class UsersApiGroup extends HttpApiGroup.make("users")
  .add(HttpApiEndpoint.get("list", "/", { query: { search: Schema.optional(Schema.String) }, success: Schema.Array(User) }))
  .add(HttpApiEndpoint.post("create", "/", { payload: Schema.Struct({ name: Schema.String }), success: User }))
  .add(HttpApiEndpoint.patch("update", "/:id", { params: { id: ... }, payload: ..., success: User, error: UserNotFound.pipe(HttpApiSchema.status(404)) }))
  .prefix("/users") {}
```

- Options object per endpoint: `params`, `query`, `headers`, `payload`,
  `success`, `error`. GET `payload` maps to the query string.
- Status codes: `HttpApiSchema.status(201)` / `.status(404)` annotate schemas;
  `HttpApiSchema.NoContent` is the default success (204).
- Handlers:
  `HttpApiBuilder.group(Api, "users", Effect.fn(function*(handlers) {
    const users = yield* Users; return handlers.handle("list", ({ query }) => ...)
  })).pipe(Layer.provide([Users.layer]))`
- App assembly: `HttpApiBuilder.layer(Api, { openapiPath? })` →
  `Layer.provide([...handlerLayers])`; extra route layers merged with
  `Layer.mergeAll`; served via `HttpRouter.serve(AllRoutes).pipe(
  Layer.provide(NodeHttpServer.layer(createServer, { port, hostname })))`
  then `Layer.launch` + `NodeRuntime.runMain`.
- `NodeHttpServer.layer(evaluate, options)` — options extends `Net.ListenOptions`
  so `{ port, hostname: "127.0.0.1" }` works; graceful shutdown built in
  (`gracefulShutdownTimeout`, `disablePreemptiveShutdown`).

### Raw routes / SSE / static

- Raw routes can coexist with HttpApi as router layers:
  `HttpRouter.add(method, path, handler)` (handler may be a plain Effect or
  fn taking `HttpServerRequest`); layers combined via `Layer.mergeAll` —
  same mechanism as the `HttpApiScalar.layer` docs route.
- **SSE**: `HttpServerResponse.stream(Stream<Uint8Array>, { headers, contentType? })`
  — build the SSE byte stream from the Watcher PubSub with
  `Stream.fromPubSub`-style combinators, encode frames manually
  (`event: <type>\ndata: {...}\n\n`), merge 30s pings. No first-class SSE helper
  exists in unstable/http — hand-rolled frames are required (same as our plan).
- **Static files**: `HttpStaticServer` (in `effect/unstable/http`) serves a
  root dir with index files, SPA fallback, MIME, cache-control, ranges, 304s —
  replaces `@hono/node-server/serve-static`. Requires HttpPlatform/FileSystem
  services (provided by NodeHttpServer.layer). Can be mounted as an app or
  combined with the router; our `findWebRoot()` guard stays for the
  dev-vs-built distinction.

### @effect/vitest

Exports `it.effect`, `it.layer`, `it.live`, `it.scoped`-style testers
(`Vitest.Methods`); re-exports all of vitest. Use `it.effect` + test Layers for
Step 11.

### Implications for the plan

- Step 7/8 unchanged in substance; SSE confirmed as a raw `HttpRouter.add`
  route + `HttpServerResponse.stream` (hand-rolled frames).
- Static serving can use `HttpStaticServer` instead of hand-rolled file
  responses; keep `findWebRoot()` gating (require index.html + assets/) and the
  SPA fallback text.
- Entry point: `Layer.launch(HttpServerLayer).pipe(NodeRuntime.runMain)` —
  signal handling + teardown come from runMain; session-clear goes in a Layer
  finalizer (or addFinalizer) to fix the double-close bug found in Step 0.
- `Effect.fn` style: generators with combinators as fn args, no inner `.pipe`.

---

## Appendix A — Step 0 baseline findings (recorded 2026-02)

All gates green at baseline commit:
- `pnpm typecheck` ✓
- `pnpm test` — 4 files, **31 tests passed**
- `pnpm build` ✓ (dist/server/cli.js 8.5kb, dist/mcp/server.js 8.9kb)

### Pre-existing bug found (not blocking)

`src/server/cli.ts` registers `shutdown()` on **both** `process.on("exit")` and
`SIGINT`/`SIGTERM` handlers, and the signal handlers call `shutdown()` then
`process.exit()` (which re-fires `exit` → `shutdown()` again). Second run calls
`store.close()` on an already-closed DB and throws
`Error: database is not open` during shutdown. Harmless today (process is
dying anyway) but confirmed by smoke test — the Effect migration's finalizer
approach fixes this for free (release runs exactly once per scope).

### Reference API behavior (to preserve byte-for-byte)

Captured against a scratch repo (`/tmp/diffreview-smoke`, port 4799):

- `GET /api/meta` →
  `{"repoRoot":"/tmp/diffreview-smoke","branch":"main","head":"6864409…","files":3,"additions":2,"deletions":1}`
- `GET /api/comments` → `{"comments":[]}`; `?status=bogus` →
  `{"error":"invalid status: bogus"}` **[400]**
- `POST /api/comments` valid → full Comment object **[201]**, `author: "user"`,
  `status: "open"`, camelCase timestamps (`createdAt`/`updatedAt`, ms ints)
- `POST /api/comments` invalid → **[400]** `{"error":"file: Too small: …; side: Invalid option: …"}`
  (zod issue format: `path: message`, `; `-joined)
- `PATCH /api/comments/:id` → **[200]** patched object; `?id=nope` →
  `{"error":"comment not found"}` **[404]**; invalid enum → 400 zod message
- `DELETE /api/comments/:id` → **[204]** empty body; missing id → 404 JSON
- `GET /api/diff` → `{"files":[...]}` with DiffFile shape as in shared/types.ts
- `GET /api/events` (SSE) → `event: diff\ndata: {"type":"diff","at":<ms>}` on
  watcher change (verified by touching an untracked file); ping interval only
  emits every 30s (not observed in short captures)
- Startup banner format as in `cli.ts`; `--help`/`--version` silent+fast
  (lazy store import)

Dev-mode note: `pnpm dev:server` already injects `.` and `--port 4777`, so
extra CLI args conflict when smoke testing — run
`pnpm exec tsx src/server/cli.ts <repo> --port <n>` directly.

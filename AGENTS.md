# diffreview — Agent Guide

This file exists to help future coding agents work on `diffreview` without
re-learning its architecture from scratch.

## What the project does

`diffreview` is a local web app for reviewing AI-generated Git diffs. One global
Node server supports multiple working trees, each with its own SQLite comment
store and watcher. It serves a project-scoped REST API and a tabbed React UI.
An MCP stdio server lets agents read and address comments in their invocation
working tree, independently of browser selection.

## Commands

```bash
pnpm dev          # API server (port 4777) + Vite dev UI (port 5173)
pnpm dev:server   # API server only
pnpm dev:web      # Vite dev UI only
pnpm build        # build web + bundle server + MCP (output in dist/)
pnpm start        # run the bundled global server in the foreground
pnpm test         # vitest run (suite in src/**/*.test.ts)
pnpm typecheck    # tsc --noEmit
pnpm lint         # Oxlint + local anti-slop rules
```

Global install for local CLI use:

```bash
pnpm build
pnpm link --global   # provides `diffreview` and `diffreview-mcp`
```

## High-level architecture

```text
diffreview serve (src/server/cli.ts)       Effect v4 (pinned rc)
  ├── ServerConfig + global discovery (server.json, lifetime SQLite lock)
  ├── Git service          explicit working-tree root on every operation
  ├── ProjectCatalog       projects.sqlite, canonical roots and database mappings
  ├── ProjectRegistry      lazy runtimes in server-owned child scopes
  │    └── Per project: CommentStore + Watcher + ProjectReview/cache
  ├── HttpApi REST API     /api/server, /api/projects,
  │                        /api/projects/:projectId/{meta,diff,comments,commits}
  ├── /api/events          multiplexed project/catalog SSE + heartbeats
  └── HttpStaticServer     dist/web assets + SPA fallback

Browser App → project tabs → mounted ProjectWorkspace(projectId)
diffreview open [path] → discover/start → register → project URL
MCP cwd → canonical working tree → global discovery → project-scoped HTTP
```

- Effect composition rules:
  - Services are `Context.Service` classes with a static `layer`
    (`Layer.effect` / `Layer.acquireRelease` for scoped resources).
  - `Layer.mergeAll` collapses service outputs — compose services with
    `Layer.merge`; `Layer.provide([array])` does not resolve requirements
    between array members. Watcher requires Git and CommentStore; use
    `Layer.provideMerge(core)` with a shared core layer so the watcher and
    HTTP handlers use the same single-writer store.
  - Handlers that must render their own errors use `handleRaw`; declared
    HttpApi payloads render an empty 400 on decode failure.
  - Error payloads are TaggedError classes — same-shaped plain structs are
    indistinguishable to the endpoint error-union encoder (first member wins).

- UI and MCP are **read-only consumers** of the server. The server is the only
  writer to the comment store.
- One browser SSE connection receives `{type, projectId, at}` review invalidations
  and `{type: "projects", at}` catalog invalidations. Active workspaces refetch;
  inactive workspaces refresh on activation. Reconnection refreshes catalog and
  active data. There is no server-global selected project.
- `App` owns tabs, history, theme and shared sidebar preferences. Keep workspaces
  keyed by project ID and mounted while inactive to preserve drafts, selections,
  collapse state and scroll positions. Closing a tab discards only client state.
- Web API clients are immutable project bindings. Abort obsolete reads and gate
  toasts by active workspace. Never share addressed-comment tracking across projects.
- The file sidebar uses `web/file-tree.ts` to group canonical paths into a
  folders-first tree. Folders start expanded; collapsed directory state lives
  in ProjectWorkspace so it survives mode switches and refreshes. The collapsed
  sidebar rail keeps direct file shortcuts.
- The sidebar header switches between Changed files, All files, and Commits, with
  project-local mode state. All files uses `/api/projects/:projectId/files` to list
  tracked and nonignored untracked working-tree files. Unchanged files open a
  comment-enabled `FilePreview` via `/api/projects/:projectId/file?path=...`; changed files
  still open their diff. Reads reject traversal and symlink parents, return symlink
  targets as text rather than following them, and cap contents at 1 MiB. The preview
  displays at most 10,000 lines. Current matching new-side comments appear inline;
  historical, outdated and old-side comments retain saved context above the file.
  DiffView lazily reads the same endpoint with `context=true` and the expected
  `reviewId` to expand unchanged code before, between, and after hunks in both
  layouts. The response includes bounded `baseContent` and `reviewId` fields.
  `web/diff-context.ts` reconstructs both complete sides, verifies them against
  the working-tree and base contents, and enforces a 10,000-line expansion limit.
  Hidden comments remain accessible with saved context. Text reads and diff lines
  normalize CRLF, while symlink targets remain raw.
  Comment drafts live in ProjectWorkspace keyed by review and path, surviving
  preview/diff transitions and expanded-row reloads. Editors use controlled bodies.
  File tree and preview reads abort on deactivation
  and refresh on project events and reconnection.
- Commits mode lists the current branch's history through
  `/api/projects/:projectId/commits` and reads a selected commit's diff through
  `/api/projects/:projectId/commits/:commitId/diff`. Commit diffs are read-only:
  no comment anchors, context expansion, or drafts attach to them. Commit
  selection, loaded pages, and collapse state survive mode switches; the
  component stays mounted and only renders when Commits is active. The commit
  list is paginated with `limit`/`offset` query parameters (offset assumes HEAD
  is stable between page loads).
- The sidebar's right-edge `Sidebar.ResizeHandle` uses Kumo's built-in resizing
  (200–600px). App persists its width under `diffreview-sidebar-width` in localStorage.
- There is no separate Comments tab or comment list view. The sidebar header has
  equal-width file mode and Open / Addressed / All dropdowns. The latter filters
  file comments and sidebar counts without
  hiding files. `web/comment-filter.ts` keeps Changed files scoped to the current
  review; All files includes historical comments attached to existing project files.
  DiffView keeps historical comments outside live anchors with saved context, and
  FilePreview displays saved threads above file contents and matching current
  comments inline. Both support carry-forward.
- The active workspace portals Collapse all and Unified / Split controls into App's
  header immediately before the theme toggle. Their state stays project-local;
  inactive, loading, and file-preview workspaces do not render controls there.
  There is no middle metadata bar or workspace metadata fetch.
- MCP verifies the global `server.json` descriptor against `/api/server`, then
  registers its invocation working tree. It does not auto-start the server.
- `diffreview serve` runs foreground outside Git; `diffreview [open] [path]`
  discovers or starts a detached server and opens the browser by default.
  `--no-open` prints the URL. Explicit `--port` must match an existing server.
- The launcher appends detached output to `server.log`. `server-lock.sqlite`
  holds a lifetime exclusive transaction for single-instance startup; process
  death releases it. The descriptor is written after HTTP readiness and cleared
  only by its owning instance. Stop old per-repo servers before upgrading.
- Canonical root hashes identify projects; linked worktrees stay distinct.
  Preserve the original absolute input on CLI/MCP registration so catalog lookup
  can find alias-hashed legacy databases. Old session metadata is used only for
  database recovery. Ambiguous or missing known databases fail explicitly.
- Registry initialization is deduplicated and server-owned, not request-owned.
  Failed initialization closes partial resources and allows retry. Successful
  runtimes stay loaded until shutdown. Catalog entries survive unavailable paths.
  Relocation, idle eviction, and complete historical diff snapshots are deferred.

## Code layout

```
src/
  shared/types.ts   # Cross-process contracts (no runtime deps)
  server/
    cli.ts          # serve/open commands, launcher and foreground runtime
    api.ts          # HttpApi definition (endpoints, error classes, StreamSse)
    api-schemas.ts  # Effect Schema contracts mirroring shared/types.ts
    http.ts         # HttpApiBuilder handlers, static/SSE composition, serverLayer
    git.ts          # Git service (+ standalone getRepoRoot for cli/mcp)
    diff.ts         # parse-diff wrapper + untracked synthesis + anchor resolution
    store.ts        # CommentStore service (node:sqlite via sync core fns)
    watcher.ts      # Watcher service (poll fiber + change PubSub + review snapshots)
    server-discovery.ts # Global descriptor, verification, lock, detached startup
    project-path.ts # Canonical working-tree resolution
    project-catalog.ts # Persistent project metadata and legacy database selection
    project-registry.ts # Deduplicated lazy runtimes + multiplexed events
    project-runtime.ts # Scoped store/watcher/review composition
    project-review.ts # Review operations and committed-file cache
    config.ts       # Separate ServerConfig and ProjectConfig services
    paths.ts        # ~/.local/share/diff-review paths
  web/
    App.tsx         # Picker/tabs, navigation, SSE routing, shared preferences
    ProjectWorkspace.tsx # Project-local review UI, reads, mutations and toasts
    project-tabs.ts # Storage restoration and tab navigation helpers
    api.ts          # Global operations, project-bound clients, one SSE hook
    *.tsx           # FileList, DiffView, DiffTable, CommitHistory, CommentEditor, CommentThread
  mcp/
    server.ts       # MCP stdio server + 4 tools
    client.ts       # Global discovery, cwd project binding, typed HTTP helpers
    render.ts       # unified-diff text renderer for agents
```

## Conventions

### Type sharing

- `src/shared/types.ts` must stay dependency-free. Never import `effect`,
  `zod`, or React there.
- Server-side Effect Schema contracts live in `src/server/api-schemas.ts`;
  they must stay shape-compatible with `shared/types.ts` (asserted by
  `api-schemas.test.ts`).
- UI and MCP validate HTTP responses with Zod schemas in
  `src/shared/response-schemas.ts`. Keep these aligned with the shared types
  and server response schemas when changing contracts.

### Lint

- `pnpm lint` runs Oxlint and the local plugin in `tools/oxlint/anti-slop/`.
- The symbol-name rule excludes JSX attribute names so component APIs such
  as Kumo's `shape` prop remain usable. Preserve this adjustment when updating
  the vendored plugin.

### Comment anchoring rule

- Comments are anchored by `(file, side, line, lineText)`.
- Anchoring is scoped by `reviewId`. The store's singleton `current_review`
  persists `(id, head)`; every observed HEAD change creates a fresh ID, including
  when returning to a previously seen HEAD. Watcher exposes files, HEAD, and
  review ID as one snapshot. An unborn HEAD uses the empty string.
- `reviews` retains each review's base HEAD. Comments expose it as `reviewHead`
  for short-hash pills. Migration recovers the known `current_review` mapping;
  older reviews without metadata keep an absent hash rather than guessing.
- Legacy comments have a NULL `review_id` and stay unscoped. Missing/different
  review IDs produce `historical: true` and are excluded from Changed files (including
  sidebar counts), regardless of matching code or open/addressed status.
- PATCH `{ carryForward: true }` explicitly moves a comment into the current
  review without changing status. Matching anchors get updated line/context;
  missing anchors retain their saved code and remain outdated. Reopen/resolve
  alone never changes review membership. Stale UI submissions include an expected
  review ID and are rejected when the review has ended.
- `resolveAnchors()` is the single source of truth. ProjectReview supplies full
  working-tree new-side contents and base-HEAD old-side contents for commented
  paths, using the original path for renamed old sides. Reads are bounded to 1 MiB,
  secure working-tree reads are deduplicated per request, and unavailable contents
  fall back to diff lines. Unchanged files and hidden lines remain valid anchors.
  Creation and carry-forward capture full-side excerpts; readable stale content
  is rejected on creation unless a matching line can be found.
  An anchor is valid only if
  the line number and the content both match. If only content matches, the
  stored line number is updated to the new location (`outdated: false`).
- If neither matches, the comment is returned as `outdated: true` and grouped in
  the UI.
- All files shows saved comments on existing project files independently of the
  current diff. `comment-context.ts` captures a bounded excerpt on the
  commented side; the store persists it in the nullable `context` JSON column
  (migrated automatically). Saved excerpt line numbers do not change when the
  live anchor moves. Legacy comments without a snapshot can receive a matching
  HEAD excerpt at read time, falling back to `lineText` in the UI. Committed
  file reads use a bounded cache keyed by commit hash and file path. Successful
  reads expire after five minutes; failures retry after five seconds. Recovered
  HEAD context remains read-time data, not a persisted snapshot.
- The comment status filter defaults to Open and lives in ProjectWorkspace so
  switching projects preserves it. Removing the list view does not delete comments
  or change server/MCP review history APIs. Comments for paths absent from the
  working tree and current diff remain accessible through those APIs.

### Kumo / Tailwind

- The project uses `@cloudflare/kumo` for components and tokens.
- CSS source order matters: import `@cloudflare/kumo/styles.css` **before**
  Tailwind directives in `src/web/styles.css`.
- The `@source "../web/**/*.{tsx,html}"` directive tells Tailwind v4 where to
  scan for custom classes. Do not remove it or utility classes defined outside
  Kumo may be purged.
- Kumo 2.8.0 quirks memo:
  - icon-only Buttons with `shape="square"` require `aria-label`.
  - Toast is `Toasty` + `useKumoToastManager().add({ title, variant })`.
  - `TooltipProvider` is a standalone export (no `Tooltip.Provider`).
- **Theme toggle** (`src/web/components/ThemeToggle.tsx`) sets `data-mode` on `<html>` and persists
  the choice in `localStorage` under `diffreview-theme`. The inline script in `index.html`
  restores the saved choice before React hydrates; Kumo tokens and custom diff tints adapt
  automatically.

### Single-writer store

Only the server process writes to SQLite. The UI and MCP send HTTP requests.
Never add direct SQLite access from `src/web/` or `src/mcp/`.

### Path handling

- Use `diffFilePath(file)` from `src/shared/types.ts` wherever you need a
  canonical file path for a diff entry.
- Server stores comments keyed by this canonical path within the target project.
- Unscoped `/api/meta`, `/api/diff`, and `/api/comments` routes return 404.
  Unknown project IDs return 404; unavailable registered projects return 503.
  Never resolve a comment ID against another project's store.

## Common pitfalls

- **Effect release-candidate pinning:** the server runs on
  `effect@4.0.0-rc.112` (pinned, no caret) with `@effect/platform-node` /
  `@effect/vitest` at the same version. Bump all three together; check the
  v4 migration guides when upgrading (stable v4 releases will drop the
  `rc` prefix — keep the exact pins aligned across the three packages).
- **Blank page in dev:** if `findWebRoot()` in `src/server/http.ts` serves
  `src/web/` source files instead of `dist/web/`, browsers cannot execute raw
  `.tsx`. The current guard requires both `index.html` and `assets/` to exist.
  Dev UI must be opened at `http://localhost:5173`, not at the API port.
- **`/api.ts` proxied in dev:** Vite proxy must use `"/api/"` (trailing slash)
  so module requests to `/api.ts` are not forwarded to the backend.
- **`node:sqlite` warnings:** Node 25 still prints an experimental warning to
  stderr. Users can ignore it.
- **Tests zero:** vitest must be configured to ignore `vite.config.ts`'s
  `root: "src/web"`. `vitest.config.ts` sets `include: ["src/**/*.test.ts"]`.

## Adding a feature

1. Update `src/shared/types.ts` if contracts change.
2. Mirror the contract in `src/server/api-schemas.ts` (the parity test fails
   otherwise) and add the endpoint in `src/server/api.ts` + handler in
   `src/server/http.ts` if needed.
3. Add/adjust tests in `src/**/*.test.ts`.
4. Update `src/web/` if the UI needs new controls or display.
5. Update `src/mcp/server.ts` if agents need a new tool.
6. Run `pnpm typecheck`, `pnpm test`, `pnpm build` before finishing.

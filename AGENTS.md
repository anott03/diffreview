# diffreview — Agent Guide

This file exists to help future coding agents work on `diffreview` without
re-learning its architecture from scratch.

## What the project does

`diffreview` is a local web app for reviewing AI-generated git diffs. A Node
server watches the working tree, parses the diff, stores comments in SQLite, and
serves both a REST API and a static React UI. An MCP stdio server lets agents
(opencode) read the diff and mark comments as addressed.

## Commands

```bash
pnpm dev          # API server (port 4777) + Vite dev UI (port 5173)
pnpm dev:server   # API server only
pnpm dev:web      # Vite dev UI only
pnpm build        # build web + bundle server + MCP (output in dist/)
pnpm start        # run the bundled server
pnpm test         # vitest run (suite in src/**/*.test.ts)
pnpm typecheck    # tsc --noEmit
```

Global install for local CLI use:

```bash
pnpm build
pnpm link --global   # provides `diffreview` and `diffreview-mcp`
```

## High-level architecture

```text
diffreview CLI (src/server/cli.ts)          Effect v4 (pinned beta)
  ├── Git service          git commands, diff collection, tagged errors
  ├── CommentStore service SQLite at ~/.local/share/diff-review/<repo-hash>.sqlite
  ├── Watcher service      poll fiber + change PubSub (SSE fan-out)
  ├── Session service      ~/.local/share/diff-review/sessions/<repo-hash>.json
  ├── HttpApi REST API     /api/{meta,diff,comments,events} (HttpApiBuilder,
  │                        StreamSse endpoint), served over NodeHttpServer
  └── HttpStaticServer     dist/web assets + SPA fallback
                                                      ▲
                                                      │ HTTP discovery
                                    diffreview-mcp (src/mcp/server.ts)
```

- Effect composition rules (see .thoughts/effect-migration.md for the full
  migration record):
  - Services are `Context.Service` classes with a static `layer`
    (`Layer.effect` / `Layer.acquireRelease` for scoped resources).
  - `Layer.mergeAll` collapses service outputs — compose services with
    `Layer.merge`; `Layer.provide([array])` does not resolve requirements
    between array members (pre-compose, e.g. `Watcher.layer.pipe(Layer.provide(Git.layer))`).
  - Handlers that must render their own errors use `handleRaw`; declared
    HttpApi payloads render an empty 400 on decode failure.
  - Error payloads are TaggedError classes — same-shaped plain structs are
    indistinguishable to the endpoint error-union encoder (first member wins).

- UI and MCP are **read-only consumers** of the server. The server is the only
  writer to the comment store.
- UI receives invalidation events via SSE and refetches `/api/diff` + `/api/comments`.
- MCP discovers the running server by hashing the repo root and reading the
  matching session file.

## Code layout

```
src/
  shared/types.ts   # Cross-process contracts (no runtime deps)
  server/
    cli.ts          # Entry point: arg parsing, serverLayer + NodeRuntime.runMain
    api.ts          # HttpApi definition (endpoints, error classes, StreamSse)
    api-schemas.ts  # Effect Schema contracts mirroring shared/types.ts
    http.ts         # HttpApiBuilder handlers, static/SSE composition, serverLayer
    git.ts          # Git service (+ standalone getRepoRoot for cli/mcp)
    diff.ts         # parse-diff wrapper + untracked synthesis + anchor resolution
    store.ts        # CommentStore service (node:sqlite via sync core fns)
    watcher.ts      # Watcher service (poll fiber + change PubSub)
    session.ts      # Session service (+ free fns used by the MCP client)
    config.ts       # ServerConfig service
    paths.ts        # ~/.local/share/diff-review paths
  web/
    App.tsx         # Shell, SSE wiring, toasts
    api.ts          # HTTP wrappers + useServerEvents hook
    *.tsx           # FileList, DiffView, DiffTable, CommentEditor, CommentThread
  mcp/
    server.ts       # MCP stdio server + 4 tools
    client.ts       # session discovery + typed HTTP helpers
    render.ts       # unified-diff text renderer for agents
```

## Conventions

### Type sharing

- `src/shared/types.ts` must stay dependency-free. Never import `effect`,
  `zod`, or React there.
- Server-side Effect Schema contracts live in `src/server/api-schemas.ts`;
  they must stay shape-compatible with `shared/types.ts` (asserted by
  `api-schemas.test.ts`).

### Comment anchoring rule

- Comments are anchored by `(file, side, line, lineText)`.
- `resolveAnchors()` is the single source of truth. An anchor is valid only if
  the line number and the content both match. If only content matches, the
  stored line number is updated to the new location (`outdated: false`).
- If neither matches, the comment is returned as `outdated: true` and grouped in
  the UI.

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
- Server stores comments keyed by this canonical path.

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

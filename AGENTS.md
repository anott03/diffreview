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
diffreview CLI (src/server/cli.ts)
  ├── DiffWatcher    polls git, emits "diff changed" events
  ├── CommentStore   SQLite at ~/.local/share/diff-review/<repo-hash>.sqlite
  ├── Hono REST API  /api/{meta,diff,comments,events} + static UI
  └── session file   ~/.local/share/diff-review/sessions/<repo-hash>.json
                                                       ▲
                                                       │ HTTP discovery
                                     diffreview-mcp (src/mcp/server.ts)
```

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
    cli.ts          # Entry point, arg parsing, startup banner
    index.ts        # Hono app, REST routes, SSE, static UI/SPA fallback
    git.ts          # git commands + DiffWatcher
    diff.ts         # parse-diff wrapper + untracked synthesis + anchor resolution
    store.ts        # node:sqlite wrapper for comments
    session.ts      # session file write/cleanup
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

- `src/shared/types.ts` must stay dependency-free. Never import `zod` or React
  there.
- Server-side zod schemas live in `src/server/`.

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

### Single-writer store

Only the server process writes to SQLite. The UI and MCP send HTTP requests.
Never add direct SQLite access from `src/web/` or `src/mcp/`.

### Path handling

- Use `diffFilePath(file)` from `src/shared/types.ts` wherever you need a
  canonical file path for a diff entry.
- Server stores comments keyed by this canonical path.

## Common pitfalls

- **Blank page in dev:** if `findWebRoot()` in `src/server/index.ts` serves
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
2. Add server-side implementation in `src/server/` and route in
   `src/server/index.ts` if needed.
3. Add/adjust tests in `src/**/*.test.ts`.
4. Update `src/web/` if the UI needs new controls or display.
5. Update `src/mcp/server.ts` if agents need a new tool.
6. Run `pnpm typecheck`, `pnpm test`, `pnpm build` before finishing.

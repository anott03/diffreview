# diffreview — Implementation Plan

A locally-hosted web app for reviewing AI-agent-produced git diffs, with inline comments
that agents can retrieve and mark as addressed via MCP (opencode integration).

## Locked decisions

| Decision | Choice |
|---|---|
| Diff scope | Uncommitted changes vs HEAD (staged + unstaged + untracked files) |
| Layout | Unified + side-by-side, toggle in UI |
| Comment storage | Global store: `~/.local/share/diff-review/` (SQLite per repo, keyed by repo-root hash) |
| Agent integration | MCP stdio server (`diffreview-mcp`), thin HTTP client of the running web server |
| Repo scope | One repo per server instance; default port 4777 |
| Stack | Node 25, TypeScript, Hono, node:sqlite / React 19, Vite 7, Tailwind v4, @cloudflare/kumo |

## Architecture recap

```
diffreview (CLI) ── Node/Hono server, one per repo
  • git diff polling (~2s hash check) → SSE broadcast
  • comment store: ~/.local/share/diff-review/<repo-hash>.sqlite
  • session file: ~/.local/share/diff-review/sessions/<repo-hash>.json {port,pid,repoRoot,startedAt}
  • serves REST API + built React UI + SSE
        ▲ HTTP+SSE                     ▲ HTTP (discovered via session file)
  Browser (React/Kumo UI)        diffreview-mcp (stdio, spawned by opencode)
```

The server is the single writer to the store. UI gets live updates via SSE; agents via tool calls.

---

## Phase 0 — Project scaffold ✅ COMPLETE (2026-07-19)

1. [x] `git init`, create `.gitignore` (`node_modules`, `dist`, `*.log`, `coverage/`).
2. [x] `package.json` — `"type": "module"`, name `diffreview`, bins:
   - `diffreview` → `dist/server/cli.js`
   - `diffreview-mcp` → `dist/mcp/server.js`
3. [x] Install deps (installed versions):
   - runtime: `hono@4.12.31 parse-diff@0.12.0 @modelcontextprotocol/sdk@1.29.0 zod@4.4.3`
   - web: `react@19.2.7 react-dom@19.2.7 @cloudflare/kumo@2.8.0 @phosphor-icons/react@2.1.10`
   - dev: `vite@8.1.5 @vitejs/plugin-react@6.0.3 tailwindcss@4.3.3 @tailwindcss/vite@4.3.3 typescript@7.0.2 tsx@4.23.1 esbuild@0.28.1 concurrently@10.0.3 vitest@4.1.10 @types/{react,react-dom,node}`
4. [x] `tsconfig.json` — ES2022 modules, bundler resolution, strict; jsx: react-jsx. Verified via `tsc --showConfig`.
5. [x] Scripts:
   - `dev` → `concurrently -n server,web "pnpm dev:server" "pnpm dev:web"`
   - `dev:server` → `tsx watch src/server/cli.ts . --port 4777`; `dev:web` → `vite`
   - `build` → `build:web` (vite build) + `build:server` (esbuild bundle, both bins, shebang banner)
   - `start` → `node dist/server/cli.js`; `test` → `vitest run`; `typecheck` → `tsc --noEmit`

### Phase 0 decisions
- **pnpm** as package manager, pinned via `"packageManager": "pnpm@10.26.2"`; `"private": true` (local tool, bins still work via `pnpm link --global`); `"engines": {"node": ">=24"}`.
- **Scripts split** (`dev:server`/`dev:web`, `build:web`/`build:server`) so each half can run independently during Phases 1–3 when the web app doesn't exist yet.
- **esbuild `--banner:js='#!/usr/bin/env node'`** included from the start so bins are executable when linked.
- **Single tsconfig** for mixed node/web code (lib ES2022+DOM, `@types/node` auto-included) — tsc is typecheck-only; vite/esbuild/tsx handle transpile per environment.
- **TypeScript 7.0.2** installed (current latest); config verified loading.
- **pnpm blocked esbuild's postinstall** (expected pnpm 10 behavior) — verified harmless: esbuild 0.28 resolves its binary via optionalDependencies; `esbuild --version` works.
- Note: `pnpm typecheck` has no inputs until Phase 1 adds files under `src/`.
- `dev:web` has no `vite.config.ts` until Phase 4 (by design).

## Phase 1 — Shared types (`src/shared/types.ts`) ✅ COMPLETE (2026-07-19)

- [x] `DiffLine { type: "add"|"del"|"context", oldLine?, newLine?, content }`
- [x] `DiffHunk { header, oldStart, newStart, lines }`
- [x] `DiffFile { oldPath, newPath, status: "added"|"modified"|"deleted"|"renamed", isBinary, hunks, additions, deletions }`
- [x] `Comment { id, file, side: "old"|"new", line, lineText, body, author: "user"|"agent", status: "open"|"addressed", note?, outdated?, createdAt, updatedAt }`
- [x] `Meta { repoRoot, branch, head, files, additions, deletions }`
- [x] API types: `GetDiffResponse`, `ListCommentsResponse`, `CreateCommentRequest`, `UpdateCommentRequest`, `ApiErrorResponse`
- [x] SSE types: `SseEventType` (`"diff" | "comments"`), `SseEvent`
- [x] Verified: `pnpm typecheck` passes.

### Phase 1 decisions
- **`SessionInfo` included here** (not deferred to Phase 2/3): it's a cross-process contract — written by the server, read by diffreview-mcp.
- **SSE events are invalidation-only signals** (`{type, at}`); clients refetch `/api/diff` or `/api/comments`. No diff payloads over SSE → simpler, no staleness/size concerns.
- **`outdated` is computed at read time, never stored** — documented on the field.
- **Zod schemas deferred to `src/server/`** (Phase 2), keeping `shared/types.ts` dependency-free so the web bundle doesn't pull in zod.
- **`diffFilePath()` helper** is the single canonical-path rule (`newPath ?? oldPath`); comments anchor to this path.

## Phase 2 — Server ✅ COMPLETE (2026-07-19)

All modules implemented and verified: `paths.ts`, `git.ts`, `diff.ts`, `store.ts`, `session.ts`, `index.ts`, `cli.ts`.
Tests: **26 passing** (diff parse/builders/anchors, store CRUD+persistence, git integration on temp repos).
E2E on a fixture repo verified: meta, diff (modified/staged/unstaged/deleted/untracked/binary all correct), comment CRUD, zod 400s, live staleness flip, content re-anchor + persistence, SSE `diff`+`comments` events, session-file cleanup on SIGTERM.

### Phase 2 decisions
- **Added `@hono/node-server@2.0.10`** — hono core ships no Node adapter; needed for `serve` + `serveStatic`.
- **Untracked files are built directly as `DiffFile` objects** (`buildUntrackedFile`/`buildUntrackedBinaryFile` in diff.ts) — no unified-diff text round-trip, so weird paths can't be mis-parsed. >1MB untracked files are labeled binary (mislabels huge text files; acceptable v1).
- **Content-aware anchor resolution** (deviates from plan's "line-number exists" check): an anchor is valid only if line number **and** content match; otherwise re-anchor by content, else `outdated`. Consequence: editing the exact commented line flips it outdated (surfaces in the outdated group — the intended "this code changed" signal).
- **Poll hash** = HEAD sha + `status --porcelain` + full diff text + untracked mtime/size. `git add` alone → harmless no-op re-parse. Overlap guard + try/catch around each cycle (survives index.lock during rebases).
- **Static UI**: `serveStatic` falls through to `notFound` → SPA serves cached `index.html`; placeholder text when `dist/web` is absent (dev uses vite proxy instead).
- **SSE**: named events (`diff`, `comments`, 30s `ping`), invalidation-only per Phase 1 decision.
- **`node:sqlite` still prints an ExperimentalWarning on Node 25.2** (stderr only, harmless).
- **tsconfig needed explicit `"types": ["node"]`** — TypeScript 7.0.2 did not auto-include `@types/node` (fixed during this phase).
- Verification-env lesson: `pkill -f` patterns match the invoking shell's own command line — killed own pipeline once; use PID files/signal traps instead.

### 2.1 `src/server/git.ts` ✅
- `getRepoRoot(cwd)`: `git rev-parse --show-toplevel` (fail fast with friendly error).
- `getMeta(root)`: branch (`git rev-parse --abbrev-ref HEAD`), HEAD sha.
- `getDiff(root)`:
  - `git diff HEAD --no-color --find-renames --no-ext-diff` (covers staged+unstaged; falls back to `git diff --cached` against empty tree when no commits yet — detect via `git rev-parse --verify HEAD` failing; simplest: if no HEAD, use `git diff --cached` + untracked).
  - Untracked: `git ls-files --others --exclude-standard` → for each file (≤1MB, non-binary): synthesize add-only diff text `--- /dev/null` / `+++ b/<path>` with one hunk of all lines. Binary → `isBinary` flag entry.
- `pollHash(root)`: cheap hash of `git rev-parse HEAD` + `git status --porcelain` + diff length to detect change without full re-parse; full re-parse only on change.
- Poll loop: every 2s, on change → re-parse → invoke callback → SSE broadcast.

### 2.2 `src/server/diff.ts` ✅
- Wrap `parse-diff` → map to `DiffFile[]`; compute per-line `oldLine`/`newLine` numbers; per-file `additions`/`deletions`; `status` (added/deleted/renamed/modified).
- `resolveAnchors(files, comments)`: for each comment, check `(file, side, line)` exists in current diff:
  - exact match → `outdated: false`
  - else search same file/hunk vicinity for line with identical `lineText` on same side → re-anchor (update stored line, `outdated: false`)
  - else → `outdated: true`
- Unit tests for both.

### 2.3 `src/server/store.ts` ✅
- `node:sqlite` (`DatabaseSync`) at `~/.local/share/diff-review/<sha1-of-repoRoot>.sqlite`; `mkdir -p` first.
- Schema:
  ```sql
  CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    file TEXT NOT NULL,
    side TEXT NOT NULL CHECK(side IN ('old','new')),
    line INTEGER NOT NULL,
    line_text TEXT NOT NULL,
    body TEXT NOT NULL,
    author TEXT NOT NULL CHECK(author IN ('user','agent')),
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','addressed')),
    note TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_comments_status ON comments(status);
  ```
- CRUD: `list(status?, file?)`, `create(...)`, `update(id, {status?, note?, body?, line?})`, `remove(id)`, `get(id)`.
- Unit tests (temp dir DB).

### 2.4 `src/server/session.ts` ✅
- On start: write `~/.local/share/diff-review/sessions/<hash>.json` `{port, pid, repoRoot, startedAt}`.
- On exit (SIGINT/SIGTERM/exit): delete the file. Stale-file handling: MCP side verifies `pid` is alive and port responds.

### 2.5 `src/server/index.ts` — Hono app ✅
- Bind `127.0.0.1` only.
- Routes:
  - `GET /api/meta` → Meta
  - `GET /api/diff` → `{ files: DiffFile[] }` (cached from poll loop, re-parsed on demand if stale)
  - `GET /api/comments?status=&file=` → comments with `outdated` computed via `resolveAnchors`
  - `POST /api/comments` `{file, side, line, lineText, body}` → author=user
  - `PATCH /api/comments/:id` `{status?, note?, body?}` (MCP uses this for addressed+note)
  - `DELETE /api/comments/:id`
  - `GET /api/events` → SSE; events: `diff` (diff changed), `comments` (any comment mutation)
- Static: serve `dist/web` (built UI) with SPA fallback to `index.html`; in dev, Vite proxies `/api` → 4777.
- Zod-validate request bodies; 400 on invalid.

### 2.6 `src/server/cli.ts` ✅
- Args: `[repoPath=.]` `--port <n>` (default 4777) `--open` (xdg-open browser).
- Startup: resolve repo root → init store → start poll loop → start server → write session file.
- Print: URL, repo, and the opencode MCP config snippet:
  ```jsonc
  "diffreview": { "type": "local", "command": ["diffreview-mcp"], "enabled": true }
  ```

## Phase 3 — MCP server (`src/mcp/server.ts`) ✅ COMPLETE (2026-07-19)

Implemented: `server.ts` (4 tools, stdio), `client.ts` (session discovery + HTTP), `render.ts` (unified-diff text renderer, unit-tested).
Verified end-to-end with a newline-delimited JSON-RPC stdio smoke script against a live instance:
- `initialize` + `tools/list` → all 4 tools registered (SDK 1.29 + zod v4 raw shapes work fine)
- `get_diff_summary` → branch/totals/per-file stats with open-comment counts
- `get_diff` → all files, single file, unknown-file → `isError` with guidance
- `list_review_comments` → open default, status filter works
- `mark_comment_addressed` → bogus id → `isError`; real id → status+note persisted and visible via `status=addressed`; SDK input validation catches missing args
- no running instance → `isError` with actionable message ("Ask the user to start one with: diffreview <path>")
- `pnpm build:server` bundles cleanly (top-level await OK in ESM output, shebang banner present)

### Phase 3 decisions
- **`get_diff` returns unified-diff *text*, not structured JSON** — the format agents parse best and far more token-efficient; 100KB truncation guard pointing at the `file` filter.
- **`list_review_comments` defaults to `status=open`** (the agent's work queue); timestamps rendered ISO 8601.
- **Session validation is three-layered**: pid alive → port answering → `repoRoot` match. Every failure mode has a distinct, agent-actionable error message.
- **MCP server logs to stderr only** — stdout is reserved for the protocol channel.
- Smoke script was throwaway (`/tmp/mcp-smoke.mjs`, deleted); durable coverage is `render.test.ts` + the HTTP-layer tests.

- [x] `@modelcontextprotocol/sdk`: `McpServer` + `StdioServerTransport`.
- [x] Discovery: `git rev-parse --show-toplevel` from cwd → hash → session file → `http://127.0.0.1:<port>`; verify `GET /api/meta` repoRoot match; stale/missing → clear error text.
- [x] Tools (zod schemas):
  - [x] `get_diff_summary` → `{branch, totals, files: [{path, status, additions, deletions, openComments}]}`
  - [x] `get_diff` `{file?}` → unified diff text (per-file when `file` given)
  - [x] `list_review_comments` `{status?, file?}` → comments incl. `outdated`, `lineText`, `body`
  - [x] `mark_comment_addressed` `{id, note?}` → PATCH status=addressed + note; returns updated comment
- [x] Agent-oriented tool descriptions ("fix the code first, then mark addressed with a note").

## Phase 4 — Web UI (`src/web/`) ✅ COMPLETE (2026-07-19)

Implemented: `vite.config.ts`, `index.html`, `styles.css`, `main.tsx`, `api.ts`, `App.tsx`,
`FileList.tsx`, `DiffView.tsx`, `DiffTable.tsx` (unified + split), `CommentEditor.tsx`,
`CommentThread.tsx`, `EmptyState.tsx`.
Verified: `pnpm typecheck` clean; `vite build` clean (4620 modules); prod server serves built UI,
API, SPA fallback (html for non-/api), JSON 404 for unknown /api; built CSS contains both kumo
utilities (`.bg-kumo-base`, `.text-kumo-subtle`, `.bg-kumo-success-tint`) and custom `.diff-add`/`.diff-del`
(the `@source` wiring works); vite dev server proxies `/api` → 4777.

### Phase 4 decisions
- **Bugfix (post-eyeball, 2026-07-19): blank page in dev.** `findWebRoot()` resolved `../web`
  from `src/server/index.ts` → matched the *source* `src/web`, so the dev server on 4777 served
  `index.html` pointing at raw `.tsx` (browser: MIME `application/octet-stream`, blank page).
  Fixes: (1) web root now requires `index.html` **and** `assets/` (only a vite build has both);
  (2) the not-built placeholder is a proper 404 and names the dev URL (`http://localhost:5173`);
  (3) the CLI banner is dev-aware — prints "UI: not built … (dev mode: open the vite dev server
  at http://localhost:5173)" when there's no build. Verified: dev(tsx) `/` → 404 placeholder;
  prod(dist) `/` → 200, JS assets served `text/javascript`.
- **Bugfix (post-eyeball, 2026-07-19): `/api.ts` proxied in dev.** Vite's proxy prefix
  `"/api"` also matched the module URL for `src/web/api.ts` (`/api.ts`), forwarding it to the
  backend and producing a 404/blank app. Proxy now uses `"/api/"` with a trailing slash. Verified:
  `/api.ts` → `200 text/javascript`; `/api/meta` still proxies → `200 application/json`.
- **Kumo `Sidebar` intentionally not used** — it's a full nav-panel system (providers, collapse
  modes); a plain `<aside>` with kumo tokens is the right weight for a file list. Documented as a
  deliberate deviation from the plan.
- **No kumo `Tooltip` in the per-line hot path** — hundreds of Base UI instances on large diffs
  isn't worth it; gutter buttons use `title` attrs. Kumo components used: `Button`, `Badge`,
  `Tabs`, `InputArea`, `Empty`, `Loader`, `Toasty` (+ `useKumoToastManager`), `cn`.
- **Diff tints are `color-mix()` of kumo's own `--color-kumo-success-tint`/`--color-kumo-danger-tint`**
  (not bespoke light-dark vars as originally planned) — fully token-native, adapts with data-mode.
- **Outdated-comments group uses native `<details>`** instead of kumo Collapsible (simpler; fine).
- **Kumo API findings (kumo 2.8.0)**: icon-only `shape="square"` Buttons **require `aria-label`**;
  toast is `Toasty` + `useKumoToastManager().add({title, variant})`; `TooltipProvider` is a
  standalone export (no `Tooltip.Provider` namespace) — dropped since v1 uses `title` attrs.
- **Phosphor 2.1.10**: `FilePencil`/`FileArrowRight` don't exist → using `NotePencil`/`ArrowRight`.
- **TS 7 needs `src/web/vite-env.d.ts`** (`/// <reference types="vite/client" />`) for the CSS
  side-effect import.
- **`vitest.config.ts` added** — vitest was reading `vite.config.ts`'s `root: "src/web"` and
  finding zero tests. Separate config with explicit `include: ["src/**/*.test.ts"]` (vitest
  prefers `vitest.config.ts` over `vite.config.ts`).
- **Agent-activity toast**: open→addressed transitions between comment snapshots (which only the
  MCP/PATCH path can produce) trigger "N comment(s) marked addressed by agent".
- Test-harness note: backgrounded dev servers need `setsid`+`disown` to survive across shell
  invocations; user-facing `pnpm dev` (concurrently, foreground) is unaffected.
- Remaining manual step: browser eyeball pass (user).

### 4.0 Setup ✅
- [x] `src/web/styles.css` — kumo-before-tailwind import order + `@source` directive.
- [x] `index.html` — `data-mode` follows `prefers-color-scheme`, default dark.
- [x] Vite config: root `src/web`, `/api` proxy → 4777, outDir `dist/web`.

### 4.1 `api.ts` ✅
- [x] Typed fetch wrappers + `useServerEvents` SSE hook (invalidation → refetch).

### 4.2 Components
- **App.tsx** ✅: header (repo, branch badge, +/−, open/addressed counts, layout Tabs), aside + main, SSE wiring, agent-activity toasts.
- **FileList.tsx** ✅: status icon, path, +/−, open-comment badge, selection.
- **DiffView.tsx** ✅: per-file header, outdated `<details>` group, unified | split via Kumo `Tabs`.
- **DiffTable.tsx** ✅: unified rows `[+ btn][old#][new#][code]`; split rows with paired del/add columns, comment gutters both sides; inline threads/editor under anchored rows.
- **CommentEditor.tsx** ✅: Kumo `InputArea` (autoResize) + primary/ghost `Button`; ⌘/Ctrl+Enter submits, Esc cancels; stays open on error.
- **CommentThread.tsx** ✅: author/status/outdated badges, agent note display, reopen + delete actions, relative time.
- **EmptyState.tsx** ✅: Kumo `Empty` — "Working tree clean".

## Phase 5 — Packaging ✅ COMPLETE (2026-07-19)

- [x] esbuild bundle server+mcp (`--packages=external`), shebang preserved via `banner`.
- [x] Added `--splitting` so `await import("./store.js")` stays a separate chunk; this lets
      `diffreview --help` / `--version` run before `node:sqlite` is loaded (no experimental warning).
- [x] Added `-v, --version` CLI option.
- [x] Refined server startup error handling to distinguish `EADDRINUSE` from other failures.
- [x] `vite build` → `dist/web`.
- [x] `pnpm link --global` verified: both `diffreview` and `diffreview-mcp` are on PATH, start
      correctly, serve built UI, and hit the SQLite-backed API. Unlinked afterwards to keep the
      environment clean.
- [x] README.md: install, run, opencode config block, development commands.
- [x] AGENTS.md: architecture, commands, conventions (kumo token rules, single-writer store rule).

### Phase 5 decisions
- **`--splitting` required for lazy chunk**: with plain `--bundle`, esbuild hoisted the dynamic
  `import("./store.js")` into the cli entry chunk, so `node:sqlite` loaded even for `--help`.
  `--splitting` leaves store in its own chunk (`dist/store-<hash>.js`) and only evaluates it after
  argument parsing. Verified: `diffreview --help` no longer prints SQLite warning.
- **Error messages**: binding to an in-use port now says exactly that; other failures pass through
  the underlying message.
- **No `files` field added** — package is `private`, so `pnpm link` uses the whole directory; adding
  `files` is only relevant for npm publishing, which is out of scope.

## Phase 6 — Verification (end-to-end) ✅ COMPLETE (2026-07-19)

All planned checks executed against `/tmp/diffreview-fixture`. One small bug was fixed during the run.

1. [x] **Fixture repo**: `alpha.txt` modified (unstaged), `beta.txt` modified + staged, `gamma.txt`
   deleted, `original.txt` renamed to `renamed_final.txt`, `delta.txt` untracked text added,
   `binary.bin` untracked binary added.
2. [x] **Route check**: `GET /api/meta` returned correct branch/totals; `GET /api/diff` showed all
   six files with correct `status` and `isBinary`. Rename detected as `renamed`.
3. [x] **Comment lifecycle**: created comment on `alpha.txt` new line 1 (`outdated:false`) → edited
   the line → after poll refetch `outdated:true` → `PATCH` to `status=addressed` with note
   persisted → `DELETE` returned 204, list empty.
4. [x] **SSE**: `curl -N /api/events` observed `event: diff` after file change and `event: comments`
   after comment creation.
5. [x] **MCP smoke**: stdio JSON-RPC script exercised `initialize`, `tools/list`,
   `get_diff_summary`, `get_diff`, `list_review_comments`, `mark_comment_addressed` (real id and
   bad id). With the server down, `get_diff_summary` returned a clean error message pointing at
   `diffreview <repo>`.
6. [x] **UI serving**: prod server (`http://127.0.0.1:5888`) returned built HTML + CSS assets with
   correct MIME types. Vite dev server (`http://localhost:5173`) returned `index.html` and served
   `/api.ts` as JS. Interactive click-through (toggle layouts, inline comments, staleness group) was
   not automated and remains a manual step for the user.
7. [x] **`pnpm build` + run from `dist/` + `pnpm test`**: green.

### Phase 6 bugfix: pure rename incorrectly marked binary

During route verification, `original.txt -> renamed_final.txt` showed `isBinary:true` despite being a
100% text rename. Root cause in `src/server/diff.ts`: the fallback `isBinary` rule that catches empty
content also caught pure renames (no hunks + no additions/deletions). Added `status !== "renamed"` to
that clause; pure renames now show `isBinary:false`. Added a unit test; suite now **31 passing**.

## Test matrix (vitest)

- `diff.ts`: parse modified/added/deleted/renamed files; untracked synthesis; binary detection.
- anchor resolution: exact, re-anchored by content, outdated.
- `store.ts`: CRUD + filters + persistence across reopen.
- `git.ts` (integration, temp repos): diff HEAD with staged+unstaged; untracked listing; no-commits-yet repo.

## Out of scope (v1)

Arbitrary base refs, comment reply threads beyond the address note, multi-repo dashboard, auth, in-diff syntax highlighting (shiki later), publishing to npm.

## Risks / watch-items

- Kumo CSS ordering + `@source` path correctness (most likely styling failure point — check first if UI looks unstyled).
- `node:sqlite` availability (Node ≥23.4 unflagged; we're on v25 — fine).
- Untracked large/binary files — cap at 1MB, detect NUL byte.
- Repo with zero commits (no HEAD) — fallback diff path.
- Session file staleness after crash — MCP verifies pid/port before use.

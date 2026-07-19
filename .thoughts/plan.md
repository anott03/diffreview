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

## Phase 2 — Server

### 2.1 `src/server/git.ts`
- `getRepoRoot(cwd)`: `git rev-parse --show-toplevel` (fail fast with friendly error).
- `getMeta(root)`: branch (`git rev-parse --abbrev-ref HEAD`), HEAD sha.
- `getDiff(root)`:
  - `git diff HEAD --no-color --find-renames --no-ext-diff` (covers staged+unstaged; falls back to `git diff --cached` against empty tree when no commits yet — detect via `git rev-parse --verify HEAD` failing; simplest: if no HEAD, use `git diff --cached` + untracked).
  - Untracked: `git ls-files --others --exclude-standard` → for each file (≤1MB, non-binary): synthesize add-only diff text `--- /dev/null` / `+++ b/<path>` with one hunk of all lines. Binary → `isBinary` flag entry.
- `pollHash(root)`: cheap hash of `git rev-parse HEAD` + `git status --porcelain` + diff length to detect change without full re-parse; full re-parse only on change.
- Poll loop: every 2s, on change → re-parse → invoke callback → SSE broadcast.

### 2.2 `src/server/diff.ts`
- Wrap `parse-diff` → map to `DiffFile[]`; compute per-line `oldLine`/`newLine` numbers; per-file `additions`/`deletions`; `status` (added/deleted/renamed/modified).
- `resolveAnchors(files, comments)`: for each comment, check `(file, side, line)` exists in current diff:
  - exact match → `outdated: false`
  - else search same file/hunk vicinity for line with identical `lineText` on same side → re-anchor (update stored line, `outdated: false`)
  - else → `outdated: true`
- Unit tests for both.

### 2.3 `src/server/store.ts`
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

### 2.4 `src/server/session.ts`
- On start: write `~/.local/share/diff-review/sessions/<hash>.json` `{port, pid, repoRoot, startedAt}`.
- On exit (SIGINT/SIGTERM/exit): delete the file. Stale-file handling: MCP side verifies `pid` is alive and port responds.

### 2.5 `src/server/index.ts` — Hono app
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

### 2.6 `src/server/cli.ts`
- Args: `[repoPath=.]` `--port <n>` (default 4777) `--open` (xdg-open browser).
- Startup: resolve repo root → init store → start poll loop → start server → write session file.
- Print: URL, repo, and the opencode MCP config snippet:
  ```jsonc
  "diffreview": { "type": "local", "command": ["diffreview-mcp"], "enabled": true }
  ```

## Phase 3 — MCP server (`src/mcp/server.ts`)

- `@modelcontextprotocol/sdk`: `McpServer` + `StdioServerTransport`.
- Discovery: `git rev-parse --show-toplevel` from cwd → hash → read session file → base URL `http://127.0.0.1:<port>`; verify `GET /api/meta` matches repoRoot; if missing/stale → tools return error text: "No diffreview instance for this repo. Ask the user to run `diffreview` in the repo root."
- Tools (zod schemas):
  - `get_diff_summary` → `{branch, files: [{path, status, additions, deletions, openComments}]}`
  - `get_diff` `{file?: string}` → structured files/hunks/lines (raw unified text for one file if `file` given, to save tokens)
  - `list_review_comments` `{status?: "open"|"addressed"|"all", file?: string}` → comments incl. `outdated`, `lineText`, `body`
  - `mark_comment_addressed` `{id: string, note?: string}` → PATCH status=addressed + note; returns updated comment
- Tool descriptions written for agents: "Comments were left by a human reviewing your uncommitted changes. Address each by editing code, then call mark_comment_addressed with a note describing the fix."

## Phase 4 — Web UI (`src/web/`)

### 4.0 Setup
- `src/web/styles.css` — **order matters**:
  ```css
  @source "../../node_modules/@cloudflare/kumo/dist/**/*.{js,jsx,ts,tsx}";
  @import "@cloudflare/kumo/styles/tailwind";
  @import "tailwindcss";
  ```
  plus two custom diff tokens using `light-dark()` (e.g. `--diff-add-bg`, `--diff-del-bg`) applied to row backgrounds — mirrors Kumo's token approach.
- `index.html`: `<html data-mode="dark">` (or follow `prefers-color-scheme` via tiny inline script), `<div id="root">`.
- Vite config: root `src/web`, `server.proxy: { "/api": "http://127.0.0.1:4777" }`, build outDir `../../dist/web`.

### 4.1 `api.ts`
- Typed fetch wrappers for all routes + `useEventSource` hook returning `{diffVersion, commentsVersion}` bumped on SSE events; React Query not needed — simple `useEffect` refetch on version bump.

### 4.2 Components
- **App.tsx**: header (repo name, branch badge, +/− totals, open/addressed counts, unified/split Tabs, refresh), Kumo `Sidebar` w/ FileList, main DiffView, `Toast` region. `data-mode` wrapper, `bg-kumo-base text-kumo-default` shell.
- **FileList.tsx**: each file: status icon (phosphor), path, `+x/−y`, open-comment Badge; filter toggle "hide addressed"; click selects file.
- **DiffView.tsx**: unified | split (Kumo `Tabs`).
  - Unified rows: `[+ btn][old#][new#][+/−/space][code]`.
  - Split rows: left = old side, right = new side; aligned add/del/context pairing; comment gutter on both sides.
  - Hover a line → `+` button (Kumo `Button` size sm + `Tooltip`) in gutter → opens CommentEditor below line (full-width row in unified; under the side's line in split).
- **CommentEditor.tsx**: Kumo `Input`/textarea + primary `Button` "Comment" + ghost "Cancel". Cmd/Ctrl+Enter submits.
- **CommentThread.tsx**: below anchored line: author Badge ("you"/"agent"), body, timestamp; status Badge "addressed" + agent note when set; user actions: reopen, delete. Outdated threads render in a collapsed "Outdated" group at file top.
- **EmptyState.tsx**: Kumo `Empty` — "Working tree clean" when no files.
- All styling with kumo semantic tokens only: `bg-kumo-base/elevated/recessed`, `text-kumo-default/subtle`, `border-kumo-line`; diff add/del rows use the two custom CSS vars. No raw Tailwind colors, no `dark:` variants.

## Phase 5 — Packaging

- esbuild bundle server+mcp (`--packages=external`), shebang `#!/usr/bin/env node` preserved via esbuild `banner`.
- `vite build` → `dist/web`.
- `pnpm link --global` → verify `diffreview --help` and `diffreview-mcp` on PATH.
- README.md: install, run, opencode config block, screenshots placeholder.
- AGENTS.md: architecture, commands, conventions (kumo token rules, single-writer store rule).

## Phase 6 — Verification (end-to-end)

1. **Fixture repo**: `/tmp/diffreview-fixture` with committed file, then: modify it, stage a change, delete a file, add untracked text + binary file.
2. Start server against fixture → `curl` every route; check untracked synthesis + rename handling in `/api/diff`.
3. Comment lifecycle via curl: create → appears with `outdated:false` → edit fixture line to make it stale → `outdated:true` → PATCH addressed → DELETE.
4. SSE: `curl -N /api/events` while touching files + mutating comments → both event types observed.
5. MCP: hand-rolled stdio JSON-RPC smoke script (`initialize`, `tools/list`, `tools/call` each of the 4 tools) against the running instance; also confirm clean error when server is down.
6. UI: `pnpm dev` → browser pass — toggle unified/split, comment on old+new lines in both layouts, staleness group, agent-marked badge after MCP call arrives live via SSE, kumo styles render correctly (dialog/sidebar centered = `@source` working).
7. `pnpm build` + run from `dist/` (prod path), `pnpm test` green.

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

# diffreview

A local web app for reviewing AI-generated Git diffs, with inline comments that
agents can read and mark as addressed through MCP.

## Features

- Review staged, unstaged, and untracked changes against HEAD in unified or split view.
- Open multiple working trees in project tabs, with a picker for recent projects.
- Keep selections, filters, collapsed files, scroll positions, and editor drafts
  when switching project tabs. Closing a tab discards its local workspace, not its comments.
- Add inline comments that re-anchor by content as code moves.
- Browse comments after commits, including saved code excerpts and review hashes.
- Each observed HEAD change starts a project-local review. Historical comments
  stay in Comments until explicitly carried forward. Resolve and Reopen change
  status without changing review membership.
- Receive live diff and comment updates through one browser SSE connection.
- Let agents use `get_diff_summary`, `get_diff`, `list_review_comments`, and
  `mark_comment_addressed` in their own working tree.

## Install

Requires Node 24+, Git, and pnpm.

```bash
git clone https://github.com/anott03/diffreview diffreview
cd diffreview
pnpm install
pnpm build
pnpm link --global
```

This installs `diffreview` and the stdio MCP command `diffreview-mcp`.
Use `pnpm unlink --global` to remove the links.

## Usage

Stop old per-repository diffreview processes before upgrading. The global server
must be the only process writing comment databases. Old servers do not participate
in its single-instance lock.

```bash
# Open the current working tree, starting a detached global server if needed
diffreview

# Open another project in the same server
diffreview open /path/to/repo

# Shorthand; subdirectories and symlink aliases are accepted
diffreview /path/to/repo/subdirectory

# Print the project URL without opening a browser
diffreview open /path/to/repo --no-open

# Run the server in the foreground, even outside a Git repository
diffreview serve

# Choose a port when starting a server
diffreview serve --port 4888
```

`open` and its shorthand default to the current directory and open the browser.
`--open` is accepted explicitly. An existing global server is reused regardless
of its port unless you specify `--port`; a conflicting explicit port is an error.

The built UI is at `http://127.0.0.1:4777`. The Projects picker accepts a path on
the server's machine. Each project has a shareable local URL,
`/projects/<project-id>`. Separate browser tabs can target different projects.
The server has no selected project.

Project tabs support arrow keys, Home/End, and Delete to close a project tab.
Open tab order and the active project persist in browser storage. Workspace
selections and drafts survive in-app switches, but not reloads or closing a tab.
Theme and sidebar preferences are shared across workspaces.

`serve` stays attached to its terminal and stops with Ctrl-C. Auto-started servers
survive launcher exit. To stop one, send SIGTERM to the PID in `server.json`.
Startup errors include the path to `server.log`.

## MCP configuration

For opencode, add this to `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "diffreview": {
      "type": "local",
      "command": ["diffreview-mcp"],
      "enabled": true
    }
  }
}
```

Start the global server with `diffreview serve` or `diffreview open` first.
MCP verifies global discovery and registers the working tree of its invocation
working directory. It does not need a browser tab and never follows the browser's
selected project. If no server is available, it returns launcher instructions
rather than starting a process itself.

## Data and identity

Data lives in `$XDG_DATA_HOME/diff-review`, or `~/.local/share/diff-review`:

| File | Purpose |
| --- | --- |
| `projects.sqlite` | Known projects, recent registration time, database ownership |
| `<repo-hash>.sqlite` | One project's comments, reviews, and saved context |
| `server.json` | Ready server endpoint, PID, start time, protocol and instance ID |
| `server-lock.sqlite` | Lifetime SQLite startup lock, released on process death |
| `server.log` | Appended output from detached startup |

Back up SQLite databases with the server stopped, or use SQLite's backup tools.
Do not copy only the main database file while a writer is using WAL mode.

Project IDs hash the canonical working-tree root. Symlink aliases and
subdirectories resolve to the same project; linked Git worktrees remain distinct.
Moving a repository changes its identity. Preserving identity across relocation
requires a future explicit relocation flow.

Existing comment databases are reused. Registration checks the supplied path's
aliases and legacy `sessions/*.json` metadata for old hashes. The catalog remembers
which database it chose. If multiple candidate databases exist, opening fails
rather than merging or discarding history. Reconcile them with the server stopped.
If an old alias database has no surviving session metadata, first open through
that original alias so registration can locate it. The old per-repo discovery
files are no longer used to find a running server.

Missing working trees stay in the catalog and can be retried when restored.
Missing previously initialized databases fail rather than silently creating empty
history. Closing a browser tab neither unloads its runtime nor deletes data.
Loaded runtimes remain until global shutdown; idle eviction is deferred.

## Development

Stop any detached server before running the foreground development server.

```bash
pnpm dev          # Foreground API + Vite; open http://localhost:5173
pnpm dev:server   # Foreground API only, watched for changes
pnpm dev:web      # Vite only
pnpm start        # Foreground built server
pnpm typecheck
pnpm test
pnpm lint
pnpm build
```

Vite proxies `/api/`, including SSE, to port 4777. Both Vite and the built static
server support direct project URLs. The API port serves only built UI assets,
not raw TSX. Production bundle size warnings are currently non-fatal.

## Architecture

The server uses Effect v4 with exactly pinned release-candidate packages.

- `ProjectCatalog` persists project metadata. `ProjectRegistry` deduplicates
  lazy runtime initialization and owns a child Effect scope for each project.
- A runtime shares one `CommentStore` between `Watcher` and `ProjectReview`.
  Review operations own anchoring, mutations, and a bounded committed-file cache.
- HTTP exposes `/api/server`, `/api/projects`, and project-scoped
  `/api/projects/:projectId/{meta,diff,comments}` routes. Unscoped review routes
  return 404. Unknown projects return 404; unavailable registered projects return 503.
- `/api/events` multiplexes project invalidations and catalog changes. Clients
  refresh on reconnection; inactive web workspaces refresh when activated.
- `src/web/App.tsx` owns project navigation and shared preferences. Keyed,
  mounted `ProjectWorkspace` components retain project-local state and drafts.
- `src/mcp/client.ts` resolves global discovery and constructs immutable
  project-bound HTTP URLs. Only the server writes SQLite.
- `src/server/server-discovery.ts` coordinates startup, verifies server identity,
  and manages discovery. No Git repository is required during server construction.

Review metadata and comment excerpts are not complete saved diffs. Historical
diff snapshots and saved review tabs remain future work.

## License

MIT

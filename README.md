# diffreview

A locally-hosted web app for reviewing AI-agent-produced git diffs, with inline
comments that agents can retrieve and mark as addressed via MCP.

## Features

- **Review uncommitted changes vs HEAD** — staged, unstaged, deleted, renamed and
  untracked files all in one view.
- **Inline comments** — click any old/new line to add a comment. Comments stay
  anchored as you edit the code (re-anchor by content, or surface as "outdated").
- **Unified or split diff** — toggle layout instantly.
- **Agent integration via MCP** — `get_diff_summary`, `get_diff`,
  `list_review_comments`, `mark_comment_addressed`.
- **Live updates** — the web UI refreshes automatically as the diff changes or
  the agent resolves comments.

## Install

Requires Node 24+ and a git repo.

```bash
git clone <repo> diffreview
cd diffreview
pnpm install
pnpm build
pnpm link --global
```

This adds two commands to your PATH:

- `diffreview` — start the review server for a repo.
- `diffreview-mcp` — stdio MCP server used by opencode (agents).

### Uninstall

```bash
pnpm unlink --global
```

## Usage

From the repo you want to review:

```bash
# Start server on the default port 4777
diffreview

# Custom port
diffreview --port 4888

# Review a different repo
diffreview /path/to/repo

# Open the UI automatically
diffreview --open
```

Then open the URL shown in the terminal:

- **Production UI:** `http://127.0.0.1:4777` (served by the diffreview server)
- **Development UI:** `http://localhost:5173` (Vite dev server, run `pnpm dev`)

## opencode MCP config

Add this block to `~/.config/opencode/opencode.json` (or equivalent agent
config) so opencode can discover the running server:

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

Start `diffreview` first in the repo; then ask opencode to inspect the diff or
resolve review comments.

## Development

```bash
# Run API server + Vite dev UI together (UI dev proxies /api to port 4777)
pnpm dev

# Server only
pnpm dev:server

# Web UI only
pnpm dev:web

# Type check
pnpm typecheck

# Run tests
pnpm test

# Build everything for packaging
pnpm build
```

## Architecture

- `src/server/comment-store` — single source of truth for comments.
- `src/web/` — React + Tailwind + Cloudflare Kumo UI.
- `src/mcp/` — MCP stdio server that discovers the running instance via a
  session file at `~/.local/share/diff-review/sessions/`.
- Comments live in a global SQLite database at
  `~/.local/share/diff-review/<repo-hash>.sqlite`.

## License

MIT

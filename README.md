# cursor-chat-browser

> **Deprecated.** This package is no longer the actively maintained version. Development continues in [`patryks-treadmill-claude-plugins`](https://github.com/patrykkopycinski/patryks-treadmill-claude-plugins) under `plugins/ai-conversation-intelligence/` (npm name `ai-chat-browser`), which has the same goals plus first-class subagent vs interactive classification, separate source adapters (`src/sources/cursor.ts`, `src/sources/claude.ts`), greedy filesystem-backed workspace path resolution, and richer per-source metadata extraction. Prefer that one for new installs.

MCP server that indexes and searches your past Cursor AI and Claude Code conversations across all workspaces.

Works with any MCP client — [Cursor](https://cursor.com), [Claude Desktop](https://claude.ai/download), [Windsurf](https://codeium.com/windsurf), and others.

## What it does

- Scans `~/.cursor/projects/*/agent-transcripts/` for Cursor conversation history
- Scans `~/.claude/projects/*/*.jsonl` for Claude Code interactive sessions (subagent transcripts are filtered out)
- Builds a persistent full-text search index (SQLite FTS4 via sql.js — zero native dependencies)
- Enriches Cursor conversations with metadata (timestamps, mode, branch) from Cursor's internal database
- Exposes 5 MCP tools for searching, browsing, and retrieving past conversations

## Quick start

Add to your MCP client config:

### Cursor

Edit `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "cursor-chat-browser": {
      "command": "npx",
      "args": ["-y", "cursor-chat-browser"]
    }
  }
}
```

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cursor-chat-browser": {
      "command": "npx",
      "args": ["-y", "cursor-chat-browser"]
    }
  }
}
```

Then restart your MCP client. The server indexes all conversations on first run (~3s for 1,000 conversations) and uses a persistent cache for fast subsequent startups (~150ms).

## Tools

### `search_conversations`

Full-text search across all past conversations.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Keywords, function names, concepts, or phrases |
| `workspace` | string | no | Filter by project name (partial match) |
| `limit` | number | no | Max results (default: 10) |

### `get_conversation`

Retrieve full content of a specific conversation.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | Conversation UUID from search results |
| `max_length` | number | no | Truncate at N chars (default: 10,000) |

### `list_workspaces`

List all workspaces with conversation counts.

### `recent_conversations`

Browse most recent conversations.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `workspace` | string | no | Filter by project name (partial match) |
| `limit` | number | no | Number of results (default: 10) |

### `reindex`

Re-scan for new conversations added since the server started.

## How it works

1. On startup, scans `~/.cursor/projects/*/agent-transcripts/` and `~/.claude/projects/*/*.jsonl` for transcript files
2. Parses each file into structured conversations (user messages, assistant responses); skips Claude Code subagent transcripts (`agent-<hash>.jsonl`)
3. Indexes into a persistent SQLite FTS4 database at `~/.cursor/chat-browser/search-index.db`
4. Optionally enriches Cursor conversations with metadata from `state.vscdb` (timestamps, mode, branch) using the system `sqlite3` CLI
5. Serves MCP tools over stdio transport

Only new conversations are parsed on subsequent runs — the index is persistent. Claude conversation IDs are prefixed with `claude:` so the source is visible in every result.

## Data sources

| Source | What it provides | Required |
|--------|-----------------|----------|
| `~/.cursor/projects/*/agent-transcripts/` | Full Cursor conversation content | Yes |
| `~/.claude/projects/*/*.jsonl` | Claude Code interactive sessions (subagents filtered) | No |
| `state.vscdb` (via `sqlite3` CLI) | Timestamps, mode, branch metadata for Cursor sessions | Optional |

## Platform support

| Platform | Transcripts | Metadata enrichment |
|----------|-------------|-------------------|
| macOS | Yes | Yes (sqlite3 pre-installed) |
| Linux | Yes | Yes (sqlite3 usually available) |
| Windows | Yes | Requires sqlite3 in PATH |

## Requirements

- Node.js >= 20
- Cursor IDE and/or Claude Code (for conversation data)

## License

[Elastic License 2.0](https://www.elastic.co/licensing/elastic-license)

# @plumb/mcp-server

Plumb as an MCP server. Exposes two tools to any MCP-compatible AI agent — Claude Desktop, Cursor, Windsurf, or any agent built on the MCP protocol.

## Tools

### `plumb_scan`

Scan a GitHub repository and get a structured report card.

```
Input:
  repo             string   GitHub URL or owner/repo (required)
  api_only         boolean  Skip clone pass (faster, less thorough)
  categories       string[] Filter to specific categories
  min_assay_score  number   Minimum Assay score to include (0–100)

Output:
  Markdown report with gaps, recommendations, and covered categories.
  Each recommendation includes the Assay score, the problem it solves,
  why it matched, and a link to the repo.
```

### `plumb_registry`

Search or browse the Assay registry without scanning a codebase.

```
Input:
  category         string   Filter by category
  query            string   Search term
  min_assay_score  number   Minimum Assay score
  limit            number   Max results (default: 10)

Output:
  Matching registry entries with scores and metadata.
```

## Setup

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "plumb": {
      "command": "npx",
      "args": ["-y", "@plumb/mcp-server"],
      "env": {
        "GITHUB_TOKEN": "ghp_your_token_here"
      }
    }
  }
}
```

Restart Claude Desktop. You can now say:

> "Scan https://github.com/acme/my-app with Plumb and tell me what I'm missing."

### Cursor

Add to `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "plumb": {
      "command": "npx",
      "args": ["-y", "@plumb/mcp-server"],
      "env": {
        "GITHUB_TOKEN": "ghp_your_token_here"
      }
    }
  }
}
```

### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "plumb": {
      "command": "npx",
      "args": ["-y", "@plumb/mcp-server"],
      "env": {
        "GITHUB_TOKEN": "ghp_your_token_here"
      }
    }
  }
}
```

### Manual (any MCP client)

```bash
GITHUB_TOKEN=ghp_xxx npx @plumb/mcp-server
```

The server communicates over stdio — standard for MCP.

## Environment variables

| Variable | Description |
|----------|-------------|
| `GITHUB_TOKEN` | GitHub PAT. Raises rate limit from 60 to 5,000 req/hr. |
| `PLUMB_REGISTRY` | Path to a local registry directory (development). |
| `PLUMB_ORG_ID` | Enterprise org ID for private registry access. |
| `PLUMB_API_ONLY` | Set to `"1"` to skip the clone pass on all scans. |

## Example agent interactions

**Scanning a repo:**
> "Use Plumb to scan github.com/acme/support-bot and tell me what AI engineering patterns we're missing."

The agent calls `plumb_scan` and returns a structured report. It can then follow up with specific recommendations from the report.

**Browsing the registry:**
> "What are the best open-source tools for LLM observability? Use Plumb to check the registry."

The agent calls `plumb_registry` with `category: "observability"` and returns scored entries.

**In a code review:**
> "Review this PR and check if we're following AI engineering best practices."

The agent can call `plumb_scan` on the repo, then reference specific gaps in its code review comments.

## Enterprise

Set `PLUMB_ORG_ID` and point `PLUMB_REGISTRY` to your private registry JSON to include internal best-practice repos alongside the community registry.

Contact enterprise@plumb.dev for private registry setup.

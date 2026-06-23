# Plumb

Scan your codebase against a curated registry of AI engineering best practices. Get a per-category report card showing which patterns you're missing, scored by real production adoption data.

## What it is

The solutions to AI coding's hardest problems — context management, evals, observability, security, RAG — already exist on GitHub. Most developers never find them. The ones they do find are hard to evaluate. Plumb fixes both.

Plumb reads your repo (dependencies, file structure, source patterns) and cross-references it against the **Assay registry**: a community-maintained, scored collection of the best open-source tools for AI-assisted codebases.

## The Assay engine

Every registry entry is scored on six signals: fork-to-star ratio, monthly active contributors, package download velocity, commit recency, issue quality, and author provenance. Stars can be purchased. Production adoption cannot.

## Packages

| Package | Description |
|---------|-------------|
| `scanner/` | Core TypeScript scanner library and CLI |
| `vscode-extension/` | VS Code sidebar panel |
| `mcp-server/` | MCP server for Claude Desktop, Cursor, Windsurf |
| `registry/` | Community-maintained YAML registry |

## Quick start

**CLI**
```bash
cd scanner
npm install
npx ts-node src/cli.ts scan https://github.com/owner/repo
```

**MCP (Claude Desktop)**
```json
{
  "mcpServers": {
    "plumb": {
      "command": "npx",
      "args": ["-y", "@plumb/mcp-server"],
      "env": { "GITHUB_TOKEN": "ghp_..." }
    }
  }
}
```

## Registry categories

- Observability (tracing, cost tracking, LLM engineering platforms)
- Testing & Evals (prompt regression, LLM metrics, workflow discipline)
- Security (guardrails, input/output scanning, red teaming)
- RAG & Retrieval (quality evaluation, reranking, document ingestion)
- Context Management (persistent memory, knowledge graph memory)
- Agent Patterns (workflow enforcement, multi-agent orchestration)
- Prompt Engineering (optimization, structured outputs, model abstraction)

## Contributing

See `docs/CONTRIBUTING.md`. The registry schema is in `schema/entry.schema.yaml`.

## License

MIT

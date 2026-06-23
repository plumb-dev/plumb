# Plumb

Open-source codebase intelligence layer for AI engineering best practices.

## Structure
- `scanner/` — @plumb/scanner TypeScript library and CLI
- `vscode-extension/` — VS Code sidebar extension
- `mcp-server/` — MCP server exposing plumb_scan and plumb_registry tools
- `registry/entries/` — YAML registry entries (community-maintained)
- `schema/` — entry.schema.yaml (the canonical registry schema)
- `docs/` — ASSAY.md, CONTRIBUTING.md, plumb-report.html (prototype)

## Key commands
- `cd scanner && npm install && npm run build` — build the scanner
- `cd scanner && npx ts-node src/cli.ts scan https://github.com/owner/repo` — run a scan
- `cd mcp-server && npm install && npm run build` — build the MCP server
- `cd vscode-extension && npm install && npm run build` — build the extension

## Registry
Each entry in registry/entries/ follows schema/entry.schema.yaml exactly.
Assay scores are computed from real GitHub data — fork ratio, contributor count,
download velocity, issue quality, and author provenance. Never edit them by hand
without a documented source.

## Types
scanner/src/types.ts is the source of truth for all data shapes.
The VS Code extension and MCP server both import from @plumb/scanner.
Do not break interfaces in types.ts — everything downstream depends on them.

## Do not
- Add registry entries without signals AND anti_signals populated
- Edit assay scores without justification and a data source
- Add console.log to the MCP server (it communicates over stdio)
- Use localStorage or sessionStorage in the VS Code webview

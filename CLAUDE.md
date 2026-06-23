# Plumb

Open-source codebase intelligence layer for AI engineering best practices.
Scans a repo, cross-references the **Assay registry**, and returns a scored report
card of the best-practice tools that repo is missing.

## Monorepo layout (npm workspaces: scanner · vscode-extension · mcp-server)

```
scanner/                  @plumb/scanner — core library + CLI. Everything depends on this.
  src/types.ts            SOURCE OF TRUTH for every data shape. Do not break these interfaces.
  src/scanner.ts          PlumbScanner orchestrator: read repo → match registry → build report.
  src/matchers/matcher.ts Signal / anti-signal matching against registry entries.
  src/readers/registryLoader.ts  Loads + validates registry YAML.
  src/github/apiReader.ts        Reads a repo via GitHub API (needs GITHUB_TOKEN).
  src/github/cloneReader.ts      Reads a repo by shallow-cloning it locally.
  src/cli.ts              `scan <repo-url>` CLI entrypoint.
  src/index.ts            Public API: PlumbScanner, types, CATEGORIES, CATEGORY_LABELS.
vscode-extension/         VS Code sidebar panel. Imports @plumb/scanner.
  src/extension.ts        activate() + command registration.
  src/PlumbPanel.ts       Webview controller.
  src/webview/template.ts Panel HTML/JS. No localStorage / sessionStorage here.
mcp-server/               MCP server over stdio. Tools: plumb_scan, plumb_registry.
  src/index.ts            Server setup + tool handlers.
registry/entries/         Community data. seed.yaml (verified entries), examples.yaml (templates).
schema/entry.schema.yaml  Canonical registry schema. Every entry conforms to it exactly.
docs/                     ASSAY.md (scoring method) · CONTRIBUTING.md · plumb-report.html (UI prototype).
```

## Commands

- `npm install` (root) — installs all workspaces (hoisted).
- `cd <pkg> && npm run build` — compiles that package with `tsc`.
- `cd scanner && npx ts-node src/cli.ts scan https://github.com/owner/repo` — run a scan.

## Assay scores

Computed from real GitHub data: fork-to-star ratio, monthly active contributors,
download velocity, commit recency, issue quality, and author provenance.
Weights and method live in `docs/ASSAY.md`. Stars can be bought; these signals can't.

## Invariants — do not

- Break interfaces in `scanner/src/types.ts` — the extension and MCP server both depend on them.
- Add a registry entry without BOTH `signals` and `anti_signals` populated.
- Edit an `assay` score without a justification and a data source.
- `console.log` in mcp-server — it speaks JSON-RPC over stdio; stray output corrupts the stream.
- Use `localStorage` / `sessionStorage` in the VS Code webview.

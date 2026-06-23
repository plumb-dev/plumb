<div align="center">

# 🔧 Plumb

**Codebase intelligence for AI engineering best practices.**

Point Plumb at a repo. It reads your dependencies, file structure, and source
patterns, cross-references them against a scored registry of the best open-source
AI tools, and hands back a report card of what you're missing — ranked by real
production adoption, not stars.

[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](LICENSE)
![Status](https://img.shields.io/badge/status-v0.1-blue.svg)
![Registry](https://img.shields.io/badge/registry-26%20entries-brightgreen.svg)
![Built with TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)

</div>

---

## The problem

The solutions to AI coding's hardest problems — context management, evals,
observability, security, RAG — **already exist on GitHub.** Two things go wrong:

1. **Discovery.** Most developers never find them.
2. **Evaluation.** The ones they do find are impossible to rank. A repo with 40k
   stars and three contributors is a worse bet than one with 4k stars and a
   thriving fork network — but stars are the only number most people see.

Plumb fixes both. It tells you *which* tools your specific codebase is missing,
and *how much you should trust* each one.

## How it works

```
  your repo ──▶  scanner  ──▶  signal matching  ──▶  report card
                   │                  ▲
                   │                  │
                   └── Assay registry ┘   (community-maintained, scored)
```

The **scanner** fingerprints your repo (dependencies, file patterns, code
patterns) and matches it against registry **signals**. **Anti-signals** suppress
anything you already handle — if you're on `mem0`, Plumb won't nag you to add a
memory layer. Each recommendation comes with an **Assay score** and a one-line
reason it applies to *you*.

### The Assay engine

Every registry entry is scored 0–100 on six signals — not stars:

| Signal | Weight | Why it matters |
|--------|:------:|----------------|
| Monthly active contributors | 25% | Is anyone actually maintaining it? |
| Fork-to-star ratio | 20% | Are people building on it, or just bookmarking it? |
| Download velocity | 20% | Real production pull from npm / PyPI / crates.io |
| Issue quality | 12.5% | Claude-scored: repro steps, stack traces, resolution depth |
| Author provenance | 12.5% | Who's behind it, and where do they ship? |
| Commit recency | 10% | Is it alive? |

> Stars can be purchased. Production adoption cannot. Full method in [`docs/ASSAY.md`](docs/ASSAY.md).

## Packages

| Package | What it is | Build |
|---------|------------|-------|
| [`scanner/`](scanner) | `@plumb/scanner` — core library + CLI. Everything depends on it. | `cd scanner && npm run build` |
| [`vscode-extension/`](vscode-extension) | VS Code sidebar that scans the open workspace | `cd vscode-extension && npm run build` |
| [`mcp-server/`](mcp-server) | MCP server exposing `plumb_scan` + `plumb_registry` to any agent | `cd mcp-server && npm run build` |
| [`registry/`](registry/entries) | Community-maintained YAML registry (26 verified entries) | — |

## Quick start

```bash
git clone https://github.com/plumb-dev/plumb.git
cd plumb
npm install            # installs all workspaces
```

**Run a scan from the CLI**

```bash
cd scanner
npx ts-node src/cli.ts scan https://github.com/owner/repo
# tip: export GITHUB_TOKEN=ghp_... to raise rate limits and scan private repos
```

**Wire it into Claude Desktop / Cursor / Windsurf (MCP)**

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

This exposes two tools to your agent: `plumb_scan` (scan a repo) and
`plumb_registry` (query the registry by category or problem).

## What a report looks like

```
Plumb report for github.com/acme/support-bot

  Observability      ●○○○○   You call openai + anthropic with zero tracing.
                             → OpenLLMetry (assay 93) · Langfuse (assay 91)
  Testing & Evals    ○○○○○   No eval harness found.
                             → promptfoo (assay 92) · DeepEval (assay 88)
  Security           ●●○○○   Inputs reach the model unscreened.
                             → LLM Guard (assay 86) · NeMo Guardrails (assay 84)
  Context Mgmt       ●●●●○   mem0 detected — you're covered.
```

(Prototype of the rendered report card: [`docs/plumb-report.html`](docs/plumb-report.html).)

## Registry categories

| Category | Covers |
|----------|--------|
| **Observability** | tracing, cost tracking, LLM engineering platforms |
| **Testing & Evals** | prompt regression, LLM metrics, workflow discipline |
| **Security** | guardrails, input/output scanning, red teaming |
| **RAG & Retrieval** | retrieval-quality evaluation, reranking, document ingestion |
| **Context Management** | persistent memory, knowledge-graph memory, stateful agents |
| **Agent Patterns** | workflow enforcement, multi-agent orchestration |
| **Prompt Engineering** | optimization, structured outputs, model abstraction |

## Contributing

The registry is the heart of Plumb, and it's community-maintained. To add a tool:

1. Read [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md) and the schema in [`schema/entry.schema.yaml`](schema/entry.schema.yaml).
2. Add an entry to [`registry/entries/seed.yaml`](registry/entries/seed.yaml) — every
   entry needs both `signals` **and** `anti_signals`.
3. Don't hand-set Assay scores without a documented data source.

Project conventions and architecture notes for contributors (and AI agents) live
in [`CLAUDE.md`](CLAUDE.md).

## License

MIT

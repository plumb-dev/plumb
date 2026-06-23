# Plumb for VS Code

Scan your repository and see which AI engineering best practices you're missing — ranked by real adoption data, not star counts.

## What it does

Plumb reads your codebase (dependencies, file structure, source patterns) and cross-references it against the Assay registry: a community-maintained collection of the best open-source solutions to fundamental AI coding problems.

The result is a per-category report card in your sidebar — each recommendation tied to the specific file or dependency that triggered it, with an Assay score that measures real production adoption.

## Getting started

1. Install the extension
2. Open a workspace with an AI-powered codebase
3. Click the Plumb icon in the activity bar
4. Click **Scan Repository**

Plumb will auto-detect your GitHub remote. If it can't, it will prompt you for a URL.

## GitHub token

Without a token, the GitHub API rate limit is 60 requests/hour — enough for small repos. For larger codebases, set a token:

```
Cmd+Shift+P → Plumb: Set GitHub Token
```

Your token is stored in VS Code's secure secrets store, never in settings.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `plumb.apiOnly` | `false` | Skip the clone pass. Faster, misses code-level patterns. |
| `plumb.autoScanOnOpen` | `false` | Scan automatically when a workspace opens. |
| `plumb.orgId` | `""` | Enterprise org ID for private registry access. |

## Output formats

From the panel footer, copy the report as Markdown to paste into a PR description, ADR, or team doc.

From the CLI (`npx plumb scan`), output as JSON, Markdown, or terminal color output.

## Categories

Plumb covers seven categories of AI engineering problems:

- **Observability** — tracing, cost tracking, logging
- **Testing & Evals** — LLM output validation, regression testing
- **Security** — prompt injection, data leakage
- **RAG & Retrieval** — chunking, reranking, retrieval quality
- **Context Management** — memory, session continuity
- **Agent Patterns** — tool use, planning, workflow enforcement
- **Prompt Engineering** — structured outputs, few-shot patterns

## The Assay engine

Every registry entry is scored on six signals: fork-to-star ratio, monthly active contributors, package download velocity, commit recency, issue quality, and author provenance. The composite score (0–100) is displayed next to each recommendation.

Stars can be bought. Production adoption can't.

## Enterprise

Private registries let your org add internal best-practice repos alongside the community registry. Team dashboards, SSO, and audit logs available on the enterprise plan.

Contact: enterprise@plumb.dev

## Open source

The registry and scanner are MIT licensed. Contributions welcome at github.com/plumb-dev/registry.

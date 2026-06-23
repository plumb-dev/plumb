#!/usr/bin/env node

// ─────────────────────────────────────────────────────────────────────────────
// Plumb MCP Server
//
// Exposes two tools to any MCP-compatible agent (Claude, Cursor, Windsurf, etc):
//
//   plumb_scan       — scan a GitHub repo, return a structured report
//   plumb_registry   — search or list the Assay registry entries
//
// Transport: stdio (standard for Claude Desktop / VS Code MCP config)
//
// Configuration (environment variables):
//   GITHUB_TOKEN     — GitHub PAT for higher rate limits
//   PLUMB_REGISTRY   — path to local registry directory (dev)
//   PLUMB_ORG_ID     — enterprise org ID for private registry access
//   PLUMB_API_ONLY   — set to "1" to skip the clone pass
// ─────────────────────────────────────────────────────────────────────────────

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import * as path from 'path';
import * as fs from 'fs';
import { PlumbScanner, CATEGORIES, CATEGORY_LABELS } from '@plumb/scanner';
import type { PlumbReport, CategoryResult, RecommendationResult } from '@plumb/scanner';
import { RegistryLoader } from '@plumb/scanner/dist/readers/registryLoader';

// ─────────────────────────────────────────────────────────────────────────────
// Tool definitions
// ─────────────────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'plumb_scan',
    description: [
      'Scan a GitHub repository against the Assay registry of AI engineering best practices.',
      'Returns a structured report card showing which patterns are missing, which are covered,',
      'and which community-verified repos would address each gap.',
      '',
      'Use this when a developer asks about improving their AI codebase, evaluating their',
      'engineering practices, or finding tools for observability, evals, security, RAG,',
      'context management, agent patterns, or prompt engineering.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'GitHub repository URL (https://github.com/owner/repo) or shorthand (owner/repo)',
        },
        api_only: {
          type: 'boolean',
          description: 'Skip the clone pass. Faster but misses code-level pattern matching. Default: false.',
        },
        categories: {
          type: 'array',
          items: {
            type: 'string',
            enum: CATEGORIES,
          },
          description: 'Filter results to specific categories. Omit to return all.',
        },
        min_assay_score: {
          type: 'number',
          description: 'Only include recommendations with an Assay score at or above this value (0–100). Default: 0.',
        },
      },
      required: ['repo'],
    },
  },
  {
    name: 'plumb_registry',
    description: [
      'Search or browse the Assay registry of verified AI engineering repos.',
      'Returns registry entries with their Assay scores and metadata.',
      '',
      'Use this when a developer asks about tools for a specific AI engineering problem',
      'without providing a codebase to scan.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: CATEGORIES,
          description: 'Filter by category.',
        },
        query: {
          type: 'string',
          description: 'Search term matched against entry name, problem_solved, and subcategory.',
        },
        min_assay_score: {
          type: 'number',
          description: 'Minimum Assay score (0–100). Default: 0.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return. Default: 10.',
        },
      },
      required: [],
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Server setup
// ─────────────────────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'plumb', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

// ── List tools ──────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

// ── Call tool ───────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request: { params: { name: string; arguments?: Record<string, unknown> } }) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'plumb_scan':
        return await handleScan(args as unknown as ScanArgs);
      case 'plumb_registry':
        return await handleRegistry(args as unknown as RegistryArgs);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    };
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool handlers
// ─────────────────────────────────────────────────────────────────────────────

interface ScanArgs {
  repo: string;
  api_only?: boolean;
  categories?: string[];
  min_assay_score?: number;
}

interface RegistryArgs {
  category?: string;
  query?: string;
  min_assay_score?: number;
  limit?: number;
}

async function handleScan(args: ScanArgs) {
  const registryDir = resolveRegistryDir();
  const scanner = new PlumbScanner({
    githubToken: process.env.GITHUB_TOKEN,
    apiOnly: args.api_only ?? process.env.PLUMB_API_ONLY === '1',
    orgId: process.env.PLUMB_ORG_ID,
    registryDir,
  });

  const report = await scanner.scan({ input: args.repo });

  // Apply filters
  let categories = report.categories;
  if (args.categories?.length) {
    categories = categories.filter(c => args.categories!.includes(c.category));
  }
  if (args.min_assay_score) {
    categories = categories.map(c => ({
      ...c,
      recommendations: c.recommendations.filter(
        r => r.entry.assay.assay_score >= (args.min_assay_score ?? 0)
      ),
    }));
  }

  return {
    content: [
      {
        type: 'text',
        text: formatReportForAgent({ ...report, categories }),
      },
    ],
  };
}

async function handleRegistry(args: RegistryArgs) {
  const registryDir = resolveRegistryDir();
  const loader = new RegistryLoader();
  if (registryDir) loader.loadLocal(registryDir);

  let entries = loader.getEntries(process.env.PLUMB_ORG_ID);

  if (args.category) {
    entries = entries.filter(e => e.category === args.category);
  }

  if (args.query) {
    const q = args.query.toLowerCase();
    entries = entries.filter(e =>
      e.name.toLowerCase().includes(q) ||
      e.problem_solved.toLowerCase().includes(q) ||
      e.subcategory.toLowerCase().includes(q)
    );
  }

  if (args.min_assay_score) {
    entries = entries.filter(e => e.assay.assay_score >= (args.min_assay_score ?? 0));
  }

  entries.sort((a, b) => b.assay.assay_score - a.assay.assay_score);
  entries = entries.slice(0, args.limit ?? 10);

  if (entries.length === 0) {
    return {
      content: [{ type: 'text', text: 'No registry entries matched your query.' }],
    };
  }

  const lines = ['# Assay Registry Results', ''];
  for (const e of entries) {
    lines.push(`## ${e.name} (Assay: ${e.assay.assay_score})`);
    lines.push(`**Repo:** ${e.repo}`);
    lines.push(`**Category:** ${CATEGORY_LABELS[e.category]} › ${e.subcategory}`);
    lines.push(`**Problem solved:** ${e.problem_solved}`);
    lines.push(`**Provenance:** ${e.author_provenance.description}`);
    lines.push('');
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Report formatter (agent-optimized markdown)
//
// Designed to be maximally useful to an AI agent reading the output:
// structured, specific, actionable. Not the same as the human-facing
// terminal output — agents don't need ANSI colors, they need signal density.
// ─────────────────────────────────────────────────────────────────────────────

function formatReportForAgent(report: PlumbReport): string {
  const fp = report.fingerprint;
  const lines: string[] = [];

  lines.push(`# Plumb Report: ${fp.meta.fullName}`);
  lines.push('');
  lines.push(`**Commit:** \`${fp.meta.commit.slice(0, 7)}\``);
  lines.push(`**Scan type:** ${fp.deepScan ? 'deep (clone + API)' : 'API only'}`);
  lines.push(`**Languages detected:** ${fp.languages.join(', ') || 'none'}`);
  lines.push(`**Manifests read:** ${fp.dependencies.sources.join(', ') || 'none'}`);
  lines.push('');
  lines.push(`**Summary:** ${report.totalGaps} gaps · ${report.totalRecommendations} recommendations · ${report.totalCovered} covered`);
  lines.push('');

  // Gaps first — highest priority for the agent to act on
  const gapCats = report.categories.filter(
    c => c.recommendations.length > 0 && !c.isCovered
  );
  const coveredCats = report.categories.filter(
    c => c.isCovered && c.recommendations.length === 0
  );
  const recOnlyCats = report.categories.filter(
    c => c.recommendations.length > 0 && c.isCovered
  );

  if (gapCats.length > 0) {
    lines.push('## Gaps (missing coverage)');
    lines.push('');
    for (const cat of gapCats) {
      lines.push(`### ${cat.label}`);
      lines.push('');
      for (const rec of cat.recommendations) {
        lines.push(formatRec(rec));
      }
    }
  }

  if (recOnlyCats.length > 0) {
    lines.push('## Recommendations (partial coverage)');
    lines.push('');
    for (const cat of recOnlyCats) {
      lines.push(`### ${cat.label}`);
      lines.push('');
      for (const rec of cat.recommendations) {
        lines.push(formatRec(rec));
      }
    }
  }

  if (coveredCats.length > 0) {
    lines.push('## Covered');
    lines.push('');
    for (const cat of coveredCats) {
      lines.push(`- **${cat.label}:** ${cat.coverageNote ?? 'Covered.'}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push(`*Assay registry: ${report.registryCommit} · Generated: ${report.generatedAt}*`);

  return lines.join('\n');
}

function formatRec(rec: RecommendationResult): string {
  const lines: string[] = [];
  lines.push(`#### [${rec.entry.name}](${rec.entry.repo}) — Assay ${rec.entry.assay.assay_score}/100`);
  lines.push(`**Problem:** ${rec.entry.problem_solved}`);
  lines.push(`**Why this repo:** ${rec.renderedNote}`);
  lines.push(`**Matched on:** ${rec.matchedSignals.map(s => `\`${s.value}\``).join(', ')}`);
  if (rec.hasAntiSignal) {
    lines.push(`> ⚠️ An existing dependency may partially cover this. Verify before adopting.`);
  }
  lines.push('');
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function resolveRegistryDir(): string | undefined {
  if (process.env.PLUMB_REGISTRY) return process.env.PLUMB_REGISTRY;
  const local = path.join(__dirname, '..', '..', 'registry', 'entries');
  return fs.existsSync(local) ? local : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // MCP servers communicate via stdio — no console output after this point
}

main().catch((err) => {
  process.stderr.write(`Plumb MCP server error: ${err.message}\n`);
  process.exit(1);
});

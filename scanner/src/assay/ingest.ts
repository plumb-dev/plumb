import Anthropic from '@anthropic-ai/sdk';
import { GitHubApiReader } from '../github/apiReader';
import { AssayEngine } from './engine';
import { CATEGORIES, type Category, type RegistryEntry } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Ingestion — turn a bare repo URL into a complete, scored registry entry.
//
//   1. Read the repo (metadata, manifests, README) via the GitHub API.
//   2. Generate the editorial half (category, problem_solved, signals,
//      anti_signals, relevance_note) with Claude — the part the Assay engine
//      can't compute.
//   3. Score all six Assay signals with the engine.
//   4. Admit entries whose assay_score clears the threshold.
//
// Public entries join the community registry; pass an orgId to mint private
// enterprise entries (visibility: org) scored by the same engine.
//
// Note: ingestion scores a candidate against the batch it's run with, so the
// download subscore uses a neutral baseline when run on one repo. The canonical
// score comes from the next full `assay` run over the whole registry, where the
// per-category download medians are real.
// ─────────────────────────────────────────────────────────────────────────────

const GEN_MODEL = 'claude-haiku-4-5';
const README_TRUNCATE = 4000;

interface GeneratedMeta {
  name: string;
  category: Category;
  subcategory: string;
  problem_solved: string;
  languages: string[];
  signals: { dependencies: string[]; file_patterns: string[]; code_patterns: string[] };
  anti_signals: { dependencies: string[]; file_patterns: string[] };
  relevance_note: string;
}

const GEN_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    category: { type: 'string', enum: CATEGORIES },
    subcategory: { type: 'string' },
    problem_solved: { type: 'string' },
    languages: { type: 'array', items: { type: 'string' } },
    signals: {
      type: 'object',
      properties: {
        dependencies: { type: 'array', items: { type: 'string' } },
        file_patterns: { type: 'array', items: { type: 'string' } },
        code_patterns: { type: 'array', items: { type: 'string' } },
      },
      required: ['dependencies', 'file_patterns', 'code_patterns'],
      additionalProperties: false,
    },
    anti_signals: {
      type: 'object',
      properties: {
        dependencies: { type: 'array', items: { type: 'string' } },
        file_patterns: { type: 'array', items: { type: 'string' } },
      },
      required: ['dependencies', 'file_patterns'],
      additionalProperties: false,
    },
    relevance_note: { type: 'string' },
  },
  required: ['name', 'category', 'subcategory', 'problem_solved', 'languages',
    'signals', 'anti_signals', 'relevance_note'],
  additionalProperties: false,
} as const;

const GEN_SYSTEM =
  'You classify an open-source AI-engineering tool for the Plumb registry. Given a ' +
  'repo\'s metadata and README, produce a registry entry. Rules:\n' +
  '- category: pick the single best fit from the enum.\n' +
  '- problem_solved: one plain-English sentence — what the tool fixes.\n' +
  '- signals.dependencies: package names a CONSUMER repo would have that mean they\'d ' +
  'benefit from this tool (e.g. "openai", "anthropic", "langchain") — NOT this tool\'s own deps.\n' +
  '- signals.file_patterns / code_patterns: files or source strings that suggest relevance.\n' +
  '- anti_signals.dependencies: packages that mean the consumer ALREADY solves this ' +
  '(usually this tool itself and close substitutes), so it shouldn\'t be recommended.\n' +
  '- relevance_note: one sentence using the {signal} placeholder for the matched dependency.\n' +
  'Both signals and anti_signals must be populated.';

export class EntryGenerator {
  private anthropic: Anthropic;
  constructor(private opts: { anthropicApiKey?: string; model?: string }) {
    this.anthropic = new Anthropic({ apiKey: opts.anthropicApiKey });
  }

  async generate(ctx: {
    fullName: string; description: string | null; topics: string[];
    languages: string[]; packages: string[]; readme: string;
  }): Promise<GeneratedMeta> {
    const user =
      `Repo: ${ctx.fullName}\n` +
      `Description: ${ctx.description ?? '(none)'}\n` +
      `Topics: ${ctx.topics.join(', ') || '(none)'}\n` +
      `Languages: ${ctx.languages.join(', ') || '(unknown)'}\n` +
      `Manifest packages: ${ctx.packages.join(', ') || '(none)'}\n\n` +
      `README (truncated):\n${ctx.readme.slice(0, README_TRUNCATE) || '(none)'}`;

    const response = await this.anthropic.messages.create({
      model: this.opts.model ?? GEN_MODEL,
      max_tokens: 1024,
      system: GEN_SYSTEM,
      messages: [{ role: 'user', content: user }],
      output_config: { format: { type: 'json_schema', schema: GEN_SCHEMA } },
    } as Anthropic.MessageCreateParamsNonStreaming);

    const text = response.content.find(b => b.type === 'text');
    if (!text || text.type !== 'text' || !text.text.trim()) {
      throw new Error('Empty entry-generation response');
    }
    return JSON.parse(text.text) as GeneratedMeta;
  }
}

export interface IngestOptions {
  githubToken?: string;
  anthropicApiKey?: string;
  /** Minimum assay_score to admit (default 60). */
  threshold?: number;
  /** "public" (default) or "org" for a private enterprise entry. */
  visibility?: 'public' | 'org';
  /** Required when visibility is "org". */
  orgId?: string;
  /** Also recompute issue quality during scoring (needs the Anthropic key). */
  scoreIssues?: boolean;
  genModel?: string;
  issueModel?: string;
}

export interface IngestResult {
  url: string;
  entry?: RegistryEntry;
  admitted: boolean;
  score?: number;
  error?: string;
}

const round = (n: number, p: number): number => { const f = 10 ** p; return Math.round(n * f) / f; };
const today = (): string => new Date().toISOString().slice(0, 10);

/** Generate + score candidate entries; admit those clearing the threshold. */
export async function ingestRepos(urls: string[], opts: IngestOptions): Promise<IngestResult[]> {
  const threshold = opts.threshold ?? 60;
  const visibility = opts.visibility ?? 'public';
  if (visibility === 'org' && !opts.orgId) throw new Error('visibility "org" requires an orgId');

  const reader = new GitHubApiReader(opts.githubToken);
  const generator = new EntryGenerator({ anthropicApiKey: opts.anthropicApiKey, model: opts.genModel });

  // Build candidate entries (editorial half) — collect failures, keep going.
  const candidates: RegistryEntry[] = [];
  const results: IngestResult[] = [];
  for (const url of urls) {
    try {
      candidates.push(await buildCandidate(url, reader, generator, visibility, opts.orgId));
    } catch (err) {
      results.push({ url, admitted: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (candidates.length === 0) return results;

  // Score all six signals for the candidates.
  const engine = new AssayEngine({
    githubToken: opts.githubToken,
    scoreIssues: opts.scoreIssues,
    anthropicApiKey: opts.anthropicApiKey,
    issueModel: opts.issueModel,
  });
  const run = await engine.scoreAll(candidates);
  const byId = new Map(run.scores.map(s => [s.id, s]));

  for (const entry of candidates) {
    const s = byId.get(entry.id);
    if (!s) { results.push({ url: entry.repo, admitted: false, error: 'scoring failed' }); continue; }
    entry.assay = {
      fork_to_star_ratio: round(s.raw.forkToStarRatio, 3),
      monthly_active_contributors: s.raw.monthlyActiveContributors,
      download_velocity: s.raw.downloadVelocity,
      last_commit_days_ago: s.raw.lastCommitDaysAgo,
      issue_quality_score: round(s.issueQuality, 1),
      provenance_score: s.provenance,
      assay_score: s.assayScore,
    };
    (entry.author_provenance as { auto_verified?: boolean }).auto_verified = s.autoVerified;
    results.push({ url: entry.repo, entry, admitted: s.assayScore >= threshold, score: s.assayScore });
  }
  return results;
}

async function buildCandidate(
  url: string,
  reader: GitHubApiReader,
  generator: EntryGenerator,
  visibility: 'public' | 'org',
  orgId?: string,
): Promise<RegistryEntry> {
  const parsed = GitHubApiReader.parseUrl(url);
  if (!parsed) throw new Error(`Unparseable repo URL: ${url}`);
  const { owner, repo } = parsed;

  const meta = await reader.fetchMetadata(owner, repo);
  const tree = await reader.fetchFileTree(owner, repo, meta.commit);
  const deps = await reader.fetchDependencies(owner, repo, meta.commit, tree.files);
  const readme = await reader
    .fetchFileContent(owner, repo, meta.commit, findReadme(tree.files))
    .catch(() => '');

  const gen = await generator.generate({
    fullName: meta.fullName,
    description: meta.description,
    topics: meta.topics,
    languages: GitHubApiReader.detectLanguages(tree.files),
    packages: Object.keys(deps.all).slice(0, 60),
    readme,
  });

  return {
    id: `${owner}-${repo}`.toLowerCase(),
    name: gen.name,
    repo: `https://github.com/${owner}/${repo}`,
    author: owner,
    author_provenance: { description: '', known_orgs: [], provenance_score: 0 },
    category: gen.category,
    subcategory: gen.subcategory,
    problem_solved: gen.problem_solved,
    languages: gen.languages,
    assay: {} as RegistryEntry['assay'], // filled after scoring
    signals: gen.signals,
    anti_signals: { ...gen.anti_signals, code_patterns: [] },
    relevance_note: gen.relevance_note,
    meta: {
      added_by: 'assay-ingest',
      added_date: today(),
      verified: false,
      visibility,
      org_id: visibility === 'org' ? orgId ?? null : null,
      registry_version: '1.0.0',
    },
  };
}

function findReadme(files: string[]): string {
  return files.find(f => /^readme(\.md|\.rst|\.txt)?$/i.test(f)) ?? 'README.md';
}

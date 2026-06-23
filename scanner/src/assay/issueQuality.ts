import { Octokit } from '@octokit/rest';
import Anthropic from '@anthropic-ai/sdk';
import { GitHubApiReader } from '../github/apiReader';
import type { RegistryEntry } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Issue-quality scorer (the one LLM-judged Assay signal)
//
// Samples a repo's last ~50 closed issues and asks Claude Haiku to rate them, as
// a set, on the four criteria from docs/ASSAY.md § 5: reproduction steps,
// version specificity, error/stack-trace output, and resolution depth. The four
// 1–5 ratings are averaged into the entry's issue_quality_score.
//
// This is gated behind an opt-in flag and an ANTHROPIC_API_KEY — when it's off,
// the engine carries the entry's existing issue_quality_score forward instead.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'claude-haiku-4-5';
const MAX_ISSUES = 50;
const BODY_TRUNCATE = 600;

export interface IssueQualityBreakdown {
  reproduction_steps: number;
  version_specificity: number;
  error_output: number;
  resolution_depth: number;
}

export interface IssueQualityResult {
  /** Averaged 1–5 rating fed into the composite. */
  rating: number;
  /** Number of closed issues actually sampled. */
  sampled: number;
  breakdown: IssueQualityBreakdown;
}

const SYSTEM_PROMPT =
  'You assess the engineering quality of a GitHub repository\'s closed issues for a ' +
  'trust registry. You receive a sample of recent closed issues. Rate the sample AS A ' +
  'WHOLE on four dimensions, each an integer 1–5 (1 = almost never present, 3 = mixed, ' +
  '5 = consistently present):\n' +
  '- reproduction_steps: issues include concrete steps or a minimal repro.\n' +
  '- version_specificity: issues state versions, OS, or environment details.\n' +
  '- error_output: issues include stack traces, logs, or error messages.\n' +
  '- resolution_depth: issues show real resolution — root cause, a fix, or a linked ' +
  'PR — rather than being closed silently or as stale.\n' +
  'Judge only what the sample shows. Return the four scores.';

const SCHEMA = {
  type: 'object',
  properties: {
    reproduction_steps: { type: 'integer' },
    version_specificity: { type: 'integer' },
    error_output: { type: 'integer' },
    resolution_depth: { type: 'integer' },
  },
  required: ['reproduction_steps', 'version_specificity', 'error_output', 'resolution_depth'],
  additionalProperties: false,
} as const;

const clamp5 = (n: number): number => Math.min(5, Math.max(1, n));

export class IssueQualityScorer {
  private octokit: Octokit;
  private anthropic: Anthropic;
  private model: string;

  constructor(opts: { githubToken?: string; anthropicApiKey?: string; model?: string }) {
    this.octokit = new Octokit({ auth: opts.githubToken });
    // apiKey undefined → SDK falls back to the ANTHROPIC_API_KEY env var.
    this.anthropic = new Anthropic({ apiKey: opts.anthropicApiKey });
    this.model = opts.model ?? DEFAULT_MODEL;
  }

  /** Returns null when the repo has no usable closed issues to sample. */
  async score(entry: RegistryEntry): Promise<IssueQualityResult | null> {
    const parsed = GitHubApiReader.parseUrl(entry.repo);
    if (!parsed) throw new Error(`Unparseable repo URL: ${entry.repo}`);

    const issues = await this.fetchClosedIssues(parsed.owner, parsed.repo);
    if (issues.length === 0) return null;

    const response = await this.anthropic.messages.create({
      model: this.model,
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: renderIssues(issues) }],
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    } as Anthropic.MessageCreateParamsNonStreaming);

    const text = response.content.find(b => b.type === 'text');
    if (!text || text.type !== 'text') throw new Error('No text block in issue-quality response');
    const b = JSON.parse(text.text) as IssueQualityBreakdown;

    const breakdown: IssueQualityBreakdown = {
      reproduction_steps: clamp5(b.reproduction_steps),
      version_specificity: clamp5(b.version_specificity),
      error_output: clamp5(b.error_output),
      resolution_depth: clamp5(b.resolution_depth),
    };
    const rating =
      (breakdown.reproduction_steps + breakdown.version_specificity +
        breakdown.error_output + breakdown.resolution_depth) / 4;

    return { rating, sampled: issues.length, breakdown };
  }

  // ── Fetch the most recent closed issues (excluding PRs) ─────────────────────

  private async fetchClosedIssues(owner: string, repo: string): Promise<SampledIssue[]> {
    // Search with type:issue so PRs are excluded server-side — listForRepo mixes
    // issues and PRs, which starves the sample on PR-heavy repos.
    const { data } = await this.octokit.search.issuesAndPullRequests({
      q: `repo:${owner}/${repo} type:issue state:closed`,
      sort: 'updated', order: 'desc', per_page: MAX_ISSUES,
    });
    return data.items.map(i => ({
      number: i.number,
      title: i.title,
      body: (i.body ?? '').slice(0, BODY_TRUNCATE),
      comments: i.comments,
      stateReason: i.state_reason ?? null,
    }));
  }
}

interface SampledIssue {
  number: number;
  title: string;
  body: string;
  comments: number;
  stateReason: string | null;
}

function renderIssues(issues: SampledIssue[]): string {
  const blocks = issues.map(i =>
    `Issue #${i.number} [${i.stateReason ?? 'closed'}, ${i.comments} comments]\n` +
    `Title: ${i.title}\n` +
    `Body: ${i.body || '(empty)'}`,
  );
  return `Sample of ${issues.length} closed issues:\n\n${blocks.join('\n---\n')}`;
}

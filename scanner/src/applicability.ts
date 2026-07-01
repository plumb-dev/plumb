import Anthropic from '@anthropic-ai/sdk';
import type {
  PlumbReport, RepoFingerprint, RecommendationResult, ApplicabilityVerdict,
} from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Applicability filter
//
// A raw scan matches on package presence, so a single broad dependency (e.g.
// `anthropic`) can light up every category — most of which don't fit the repo's
// actual architecture. This pass reads the repo profile + the matched
// recommendations and triages each one the way a thoughtful engineer would:
//
//   apply   — genuinely worth adopting given what's there and what's missing
//   covered — the repo already addresses this need with its own code or deps
//   skip    — not applicable to this architecture (not doing RAG, not multiagent,
//             low-adversarial-risk internal tool, etc.)
//
// Uses Sonnet — this is a judgment task, not classification. Opt-in (scan
// --triage), needs ANTHROPIC_API_KEY.
// ─────────────────────────────────────────────────────────────────────────────

const MODEL = 'claude-sonnet-4-6';

export interface TriageVerdict { id: string; verdict: ApplicabilityVerdict; reason: string; }

const SYSTEM_PROMPT =
  'You triage tool recommendations for ONE specific codebase. You receive the ' +
  'repo profile (dependencies, files, structure) and candidate tools that an ' +
  'automated scanner flagged because a broad LLM dependency matched. The scanner ' +
  'over-recommends — your job is the honest filter. For EACH candidate decide:\n' +
  '- "apply": materially fits this architecture and addresses a real gap.\n' +
  '- "covered": the repo already handles this need (name what covers it — a file ' +
  'like sanitise.py, an existing dependency, a datastore like Supabase).\n' +
  '- "skip": does not apply to this architecture. Be concrete about why — the app ' +
  'is not doing RAG, is a single LLM call per request (not multi-agent), is an ' +
  'internal/low-adversarial-risk tool, or the tool is enterprise-scale overkill.\n' +
  'Each candidate lists the signals it matched and WHERE (file:line for code ' +
  'patterns). Weigh that evidence, not just the description: a broad dependency ' +
  'match alone is weak, but a specific code pattern found at real call sites is ' +
  'strong evidence the need is live in THIS code — e.g. raw JSON parsing of model ' +
  'output (json.loads at specific routes) means a typed-output/validation tool ' +
  'genuinely applies, even if other parts of the app return freeform text.\n' +
  'Be skeptical. Most candidates that merely matched a broad dependency are skip or ' +
  'covered; reserve "apply" for genuine fits backed by evidence. One short, ' +
  'specific reason each. Return a verdict for every candidate id.';

const schema = (ids: string[]) => ({
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', enum: ids },
          verdict: { type: 'string', enum: ['apply', 'covered', 'skip'] },
          reason: { type: 'string' },
        },
        required: ['id', 'verdict', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['verdicts'],
  additionalProperties: false,
});

export class ApplicabilityFilter {
  private anthropic: Anthropic;
  private model: string;

  constructor(opts: { anthropicApiKey?: string; model?: string }) {
    this.anthropic = new Anthropic({ apiKey: opts.anthropicApiKey });
    this.model = opts.model ?? MODEL;
  }

  /** Attaches an applicability verdict to every recommendation in the report. */
  async triage(report: PlumbReport): Promise<void> {
    const recs = report.categories.flatMap(c => c.recommendations);
    if (recs.length === 0) return;

    const ids = recs.map(r => r.entry.id);

    const user =
      `Repo profile:\n${profile(report.fingerprint)}\n\n` +
      `Candidates (each lists the signals it matched and where):\n` +
      recs.map(candidateLine).join('\n');

    const response = await this.anthropic.messages.create({
      model: this.model,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: user }],
      output_config: { format: { type: 'json_schema', schema: schema(ids) } },
    } as Anthropic.MessageCreateParamsNonStreaming);

    const text = response.content.find(b => b.type === 'text');
    if (!text || text.type !== 'text' || !text.text.trim()) {
      throw new Error('Empty applicability response');
    }
    const parsed = JSON.parse(text.text) as { verdicts: TriageVerdict[] };
    const byId = new Map(parsed.verdicts.map(v => [v.id, v]));

    for (const rec of recs) {
      const v = byId.get(rec.entry.id);
      // Default to surfacing (apply) if the model omitted one, rather than hiding it.
      rec.applicability = v
        ? { verdict: v.verdict, reason: v.reason }
        : { verdict: 'apply', reason: '' };
    }
  }
}

/** One candidate line: the tool + the concrete signals (and code locations) it matched. */
function candidateLine(r: RecommendationResult): string {
  const evidence = r.matchedSignals.map(s => {
    const locs = s.locations?.length ? ` @ ${s.locations.slice(0, 3).join(', ')}` : '';
    return `${s.value} (${s.type}${locs})`;
  }).join('; ');
  return `- ${r.entry.id} [${r.entry.category}] ${r.entry.name}: ${r.entry.problem_solved}\n` +
    `    matched: ${evidence || '(none)'}`;
}

/** A compact repo profile the model can reason about architecture from. */
function profile(fp: RepoFingerprint): string {
  const deps = Object.keys(fp.dependencies.all).sort();
  const topDirs = fp.fileStructure.directories.filter(d => !d.includes('/')).slice(0, 40);
  const basenames = Array.from(new Set(
    fp.fileStructure.files
      .map(f => f.split('/').pop() ?? f)
      .filter(b => /\.(py|ts|tsx|js|jsx|rb|go|rs)$/.test(b)),
  )).slice(0, 200);
  const codePatterns = Object.entries(fp.codePatterns.matches)
    .filter(([, v]) => v.length > 0).map(([k]) => k);

  return [
    `Name: ${fp.meta.fullName}`,
    `Description: ${fp.meta.description ?? '(none)'}`,
    `Languages: ${fp.languages.join(', ') || '(unknown)'}`,
    `Dependencies: ${deps.join(', ') || '(none)'}`,
    `Top-level dirs: ${topDirs.join(', ') || '(none)'}`,
    `Notable config files: ${fp.fileStructure.configFiles.join(', ') || '(none)'}`,
    `Source file names: ${basenames.join(', ')}`,
    codePatterns.length ? `Code patterns found: ${codePatterns.join(', ')}` : '',
  ].filter(Boolean).join('\n');
}

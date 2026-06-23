import type { Category, RegistryEntry } from '../types';
import { AssayCollector, type RawSignals } from './collector';
import { IssueQualityScorer } from './issueQuality';
import {
  forkToStarScore,
  contributorScore,
  downloadScore,
  recencyScore,
  normalizeFivePoint,
  compositeScore,
  type SubScores,
} from './scorer';

// ─────────────────────────────────────────────────────────────────────────────
// Assay Engine
//
// Re-scores registry entries from live data. Two passes are required because the
// download subscore is relative to the category median, so every entry's raw
// download velocity must be collected before any composite can be computed.
//
//   Pass 1 — collect raw signals for every entry (bounded concurrency).
//   Pass 2 — per category: derive the download-velocity median, score each
//            entry, and assign null-velocity entries the median of that
//            category's non-null download subscores (per docs/ASSAY.md § 3).
// ─────────────────────────────────────────────────────────────────────────────

export interface EntryScore {
  id: string;
  category: Category;
  raw: RawSignals;
  subScores: SubScores;
  /** Recomputed composite (0–100). */
  assayScore: number;
  /** The entry's previous composite, for diffing. */
  previousScore: number;
  /** The 1–5 issue-quality rating used (recomputed if scoreIssues, else carried forward). */
  issueQuality: number;
  /** True if issueQuality was recomputed by the LLM this run. */
  issueQualityRecomputed: boolean;
  provenance: number;
}

export interface AssayRunResult {
  scores: EntryScore[];
  errors: { id: string; error: string }[];
  /** Issue-quality scoring failures — non-fatal; the entry keeps its prior rating. */
  issueErrors: { id: string; error: string }[];
  scoredAt: string;
}

export interface AssayEngineOptions {
  githubToken?: string;
  /** Max entries collected in parallel. Default 5. */
  concurrency?: number;
  /** Called after each entry is collected, for progress UIs. */
  onProgress?: (done: number, total: number, id: string) => void;
  /** Recompute issue quality via Claude (needs anthropicApiKey / ANTHROPIC_API_KEY). */
  scoreIssues?: boolean;
  anthropicApiKey?: string;
  /** Override the issue-quality model (default claude-haiku-4-5). */
  issueModel?: string;
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** Append `value` to the array stored at `key`, creating it if absent. */
function pushTo<K>(map: Map<K, number[]>, key: K, value: number): void {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}

export class AssayEngine {
  private collector: AssayCollector;
  private concurrency: number;
  private onProgress?: AssayEngineOptions['onProgress'];
  private issueScorer?: IssueQualityScorer;

  constructor(opts: AssayEngineOptions = {}) {
    this.collector = new AssayCollector(opts.githubToken);
    this.concurrency = opts.concurrency ?? 5;
    this.onProgress = opts.onProgress;
    if (opts.scoreIssues) {
      this.issueScorer = new IssueQualityScorer({
        githubToken: opts.githubToken,
        anthropicApiKey: opts.anthropicApiKey,
        model: opts.issueModel,
      });
    }
  }

  async scoreAll(entries: RegistryEntry[]): Promise<AssayRunResult> {
    // ── Pass 1: collect raw signals + (optional) issue quality ──────────────
    const raw = new Map<string, RawSignals>();
    const issueRatings = new Map<string, number>();
    const errors: { id: string; error: string }[] = [];
    const issueErrors: { id: string; error: string }[] = [];
    let done = 0;

    const queue = [...entries];
    const worker = async () => {
      for (;;) {
        const entry = queue.shift();
        if (!entry) return;
        try {
          raw.set(entry.id, await this.collector.collect(entry));
          // Issue quality is best-effort: a failure here keeps the prior rating.
          if (this.issueScorer) {
            try {
              const r = await this.issueScorer.score(entry);
              if (r) issueRatings.set(entry.id, r.rating);
            } catch (err) {
              issueErrors.push({ id: entry.id, error: err instanceof Error ? err.message : String(err) });
            }
          }
        } catch (err) {
          errors.push({ id: entry.id, error: err instanceof Error ? err.message : String(err) });
        } finally {
          this.onProgress?.(++done, entries.length, entry.id);
        }
      }
    };
    await Promise.all(Array.from({ length: this.concurrency }, worker));

    const scored = entries.filter(e => raw.has(e.id));

    // ── Pass 2a: per-category download medians (velocity + non-null scores) ──
    const velByCat = new Map<Category, number[]>();
    for (const e of scored) {
      const v = raw.get(e.id)!.downloadVelocity;
      if (v != null) pushTo(velByCat, e.category, v);
    }
    const medianVelByCat = new Map<Category, number>();
    for (const [cat, vs] of velByCat) medianVelByCat.set(cat, median(vs));

    const dlScoreByCat = new Map<Category, number[]>();
    for (const e of scored) {
      const v = raw.get(e.id)!.downloadVelocity;
      if (v == null) continue;
      pushTo(dlScoreByCat, e.category, downloadScore(v, medianVelByCat.get(e.category) ?? 0));
    }
    const medianDlScoreByCat = new Map<Category, number>();
    for (const [cat, ss] of dlScoreByCat) medianDlScoreByCat.set(cat, median(ss));

    // ── Pass 2b: compose ────────────────────────────────────────────────────
    const scores: EntryScore[] = scored.map((e) => {
      const r = raw.get(e.id)!;
      const a = e.assay as unknown as Record<string, number | null>;

      // Provenance is always carried forward (human-set). Issue quality is
      // recomputed when scoreIssues is on, else carried forward (override wins).
      const recomputed = issueRatings.get(e.id);
      const issueRating = recomputed
        ?? (a.issue_quality_override as number | null)
        ?? (a.issue_quality_score as number) ?? 0;
      const provRating =
        (a.provenance_score as number | null) ?? e.author_provenance?.provenance_score ?? 0;

      const downloads = r.downloadVelocity != null
        ? downloadScore(r.downloadVelocity, medianVelByCat.get(e.category) ?? 0)
        : (medianDlScoreByCat.get(e.category) ?? 50); // null → category-median score

      const subScores: SubScores = {
        forkToStar: forkToStarScore(r.forkToStarRatio),
        contributors: contributorScore(r.monthlyActiveContributors),
        downloads,
        recency: recencyScore(r.lastCommitDaysAgo),
        issueQuality: normalizeFivePoint(issueRating),
        provenance: normalizeFivePoint(provRating),
      };

      return {
        id: e.id,
        category: e.category,
        raw: r,
        subScores,
        assayScore: compositeScore(subScores),
        previousScore: (a.assay_score as number) ?? 0,
        issueQuality: issueRating,
        issueQualityRecomputed: recomputed != null,
        provenance: provRating,
      };
    });

    return { scores, errors, issueErrors, scoredAt: new Date().toISOString() };
  }
}

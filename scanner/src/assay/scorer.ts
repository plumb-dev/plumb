// ─────────────────────────────────────────────────────────────────────────────
// Assay Scorer — pure scoring math
//
// Implements the six-signal model documented in docs/ASSAY.md. Every function
// here is pure (no I/O): given raw signal values it returns a 0–100 subscore,
// and `compositeScore` combines them with the published weights.
//
// Keep this file in sync with docs/ASSAY.md. The weights and curve anchors are
// the contract; the live collector (collector.ts) only supplies the inputs.
// ─────────────────────────────────────────────────────────────────────────────

/** Published signal weights. Must sum to 1.0. See docs/ASSAY.md § Composite score. */
export const WEIGHTS = {
  forkToStar: 0.20,
  contributors: 0.25,
  downloads: 0.20,
  recency: 0.10,
  issueQuality: 0.125,
  provenance: 0.125,
} as const;

const clamp = (n: number, lo = 0, hi = 100): number => Math.min(hi, Math.max(lo, n));

// ── 1. Fork-to-star ratio (20%) ──────────────────────────────────────────────
// Sigmoid centred at FORK_RATIO_CENTER (→ 50). The centre was recalibrated from
// the spec's original 0.15 to 0.10 after the first live run: real AI/LLM repos
// cluster at 0.06–0.18 (mlflow 0.22 is a high outlier), so a 0.15 centre scored
// the whole category as mediocre. See docs/ASSAY.md § 1.
//   k = 20 gives: 0.05→~31, 0.10→50, 0.15→~73, 0.22→~91
export const FORK_RATIO_CENTER = 0.10;
export function forkToStarScore(ratio: number): number {
  if (!isFinite(ratio) || ratio < 0) return 0;
  const k = 20;
  return clamp(100 / (1 + Math.exp(-k * (ratio - FORK_RATIO_CENTER))));
}

// ── 2. Monthly active contributors (25%) ─────────────────────────────────────
// Log scale anchored so that 1 contributor ≈ 10 and 30 ≈ 90.
//   score = 29.2 * ln(n + 1) − 10.24
export function contributorScore(n: number): number {
  if (!isFinite(n) || n <= 0) return 0;
  return clamp(29.2 * Math.log(n + 1) - 10.24);
}

// ── 3. Download velocity (20%) ───────────────────────────────────────────────
// Log scale relative to the category median. velocity == median → 50,
// 10× → 75, 100× → 100. Null velocity is handled by the engine (it assigns
// the median of the category's non-null download SCORES), not here.
export function downloadScore(velocity: number, categoryMedian: number): number {
  if (!isFinite(velocity) || velocity <= 0) return 0;
  if (!isFinite(categoryMedian) || categoryMedian <= 0) return 50; // no basis → neutral
  return clamp(50 + 25 * Math.log10(velocity / categoryMedian));
}

// ── 4. Last-commit recency (10%) ─────────────────────────────────────────────
// Step table from docs/ASSAY.md.
export function recencyScore(daysAgo: number): number {
  if (!isFinite(daysAgo) || daysAgo < 0) return 0;
  if (daysAgo <= 14) return 100;
  if (daysAgo <= 30) return 85;
  if (daysAgo <= 90) return 60;
  if (daysAgo <= 180) return 35;
  return 10;
}

// ── 5 & 6. Issue quality (12.5%) and provenance (12.5%) ──────────────────────
// Both arrive as a 1–5 rating and normalise linearly onto 0–100 (s/5 × 100).
export function normalizeFivePoint(rating: number): number {
  if (!isFinite(rating) || rating <= 0) return 0;
  return clamp((rating / 5) * 100);
}

// ── Composite ────────────────────────────────────────────────────────────────

export interface SubScores {
  forkToStar: number;
  contributors: number;
  downloads: number;
  recency: number;
  issueQuality: number;
  provenance: number;
}

/** Weighted composite, rounded to the nearest integer. Range 0–100. */
export function compositeScore(s: SubScores): number {
  const raw =
    s.forkToStar * WEIGHTS.forkToStar +
    s.contributors * WEIGHTS.contributors +
    s.downloads * WEIGHTS.downloads +
    s.recency * WEIGHTS.recency +
    s.issueQuality * WEIGHTS.issueQuality +
    s.provenance * WEIGHTS.provenance;
  return Math.round(clamp(raw));
}

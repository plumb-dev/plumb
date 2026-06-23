import * as fs from 'fs';
import { parseDocument, isMap, isSeq, type Scalar, type YAMLMap } from 'yaml';
import type { EntryScore } from './engine';

// ─────────────────────────────────────────────────────────────────────────────
// Registry Writer
//
// Updates the assay block of each entry in a registry YAML file in place, using
// the document model so comments, ordering, and untouched fields are preserved.
// Only the four recomputed signals + assay_score + meta.last_auto_scored change;
// issue_quality_score and provenance_score are left exactly as they were.
// ─────────────────────────────────────────────────────────────────────────────

/** Returns the updated YAML text. Does not write to disk. */
export function applyScores(yamlText: string, scores: EntryScore[], scoredAt: string): string {
  const doc = parseDocument(yamlText);
  if (!isSeq(doc.contents)) {
    throw new Error('Registry file is not a top-level YAML sequence of entries');
  }

  const byId = new Map(scores.map(s => [s.id, s]));

  for (const item of doc.contents.items) {
    if (!isMap(item)) continue;
    const id = item.get('id');
    if (typeof id !== 'string') continue;
    const score = byId.get(id);
    if (!score) continue;

    const assay = item.get('assay');
    if (!isMap(assay)) continue;

    const ratio = round(score.raw.forkToStarRatio, 3);
    setScalar(assay, 'fork_to_star_ratio', ratio,
      ` ${score.raw.forks} forks / ${score.raw.stars} stars`);
    setScalar(assay, 'monthly_active_contributors', score.raw.monthlyActiveContributors);
    setScalar(assay, 'download_velocity', score.raw.downloadVelocity,
      score.raw.downloadSource ? ` ${score.raw.downloadSource} (weekly)` : ' unpublished — category median');
    setScalar(assay, 'last_commit_days_ago', score.raw.lastCommitDaysAgo);
    // Only overwrite issue_quality_score when it was actually recomputed (LLM run).
    if (score.issueQualityRecomputed) {
      setScalar(assay, 'issue_quality_score', round(score.issueQuality, 1));
    }
    // Provenance is computed every run unless a maintainer pinned an override.
    if (!score.provenanceOverridden) {
      setScalar(assay, 'provenance_score', score.provenance);
    }
    setScalar(assay, 'assay_score', score.assayScore);

    // Honest auto_verified, replacing the hard-coded value.
    const authorProvenance = item.get('author_provenance');
    if (isMap(authorProvenance)) setScalar(authorProvenance, 'auto_verified', score.autoVerified);

    const meta = item.get('meta');
    if (isMap(meta)) setScalar(meta, 'last_auto_scored', scoredAt);
  }

  return doc.toString();
}

/** Update a registry file on disk. Returns the count of entries updated. */
export function writeScores(filePath: string, scores: EntryScore[], scoredAt: string): number {
  const text = fs.readFileSync(filePath, 'utf-8');
  const updated = applyScores(text, scores, scoredAt);
  fs.writeFileSync(filePath, updated, 'utf-8');
  return scores.length;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function setScalar(map: YAMLMap, key: string, value: unknown, comment?: string): void {
  const node = map.get(key, true) as Scalar | undefined;
  if (node && typeof node === 'object' && 'value' in node) {
    node.value = value;
    if (comment !== undefined) node.comment = comment;
  } else {
    map.set(key, value); // key was absent — add it (no inline comment available)
  }
}

function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

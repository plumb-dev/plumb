// Plumb Assay Engine — public API
//
//   import { AssayEngine } from '@plumb/scanner';
//   const engine = new AssayEngine({ githubToken: process.env.GITHUB_TOKEN });
//   const result = await engine.scoreAll(entries);
//   const yaml = applyScores(originalYaml, result.scores, result.scoredAt);

export { AssayEngine } from './engine';
export type { EntryScore, AssayRunResult, AssayEngineOptions } from './engine';
export { AssayCollector } from './collector';
export type { RawSignals } from './collector';
export { IssueQualityScorer } from './issueQuality';
export type { IssueQualityResult, IssueQualityBreakdown } from './issueQuality';
export { applyScores, writeScores } from './writer';
export {
  WEIGHTS,
  forkToStarScore,
  contributorScore,
  downloadScore,
  recencyScore,
  normalizeFivePoint,
  compositeScore,
} from './scorer';
export type { SubScores } from './scorer';

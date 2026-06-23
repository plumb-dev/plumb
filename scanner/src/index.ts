// Plumb Scanner — Public API
//
// Use this when embedding the scanner in the VS Code extension or MCP server.
//
// Example:
//   import { PlumbScanner } from '@plumb/scanner';
//
//   const scanner = new PlumbScanner({ githubToken: process.env.GITHUB_TOKEN });
//   const report = await scanner.scan({ input: 'https://github.com/acme/my-app' });

export { PlumbScanner } from './scanner';
export type { ScannerOptions } from './scanner';
export type {
  ScanTarget,
  PlumbReport,
  RepoFingerprint,
  CategoryResult,
  RecommendationResult,
  MatchedSignal,
  RegistryEntry,
  AssayScore,
  Category,
} from './types';
export { CATEGORIES, CATEGORY_LABELS } from './types';

// Assay scoring engine — re-scores registry entries from live GitHub + package data.
export * from './assay';

// ─────────────────────────────────────────
// Plumb Scanner — Core Types
// ─────────────────────────────────────────

export interface ScanTarget {
  /** Full GitHub URL or local path */
  input: string;
  /** Resolved owner/repo if GitHub */
  owner?: string;
  repo?: string;
  /** Specific commit or branch to scan */
  ref?: string;
  /** GitHub personal access token (optional, raises rate limits) */
  token?: string;
}

export interface RepoMetadata {
  name: string;
  fullName: string;
  description: string | null;
  defaultBranch: string;
  language: string | null;
  topics: string[];
  url: string;
  commit: string;
}

// ─── What the readers extract ───────────────────────────────────────────────

export interface DependencyMap {
  /** Raw package name -> version string */
  [pkg: string]: string;
}

export interface DetectedDependencies {
  /** From package.json, requirements.txt, pyproject.toml, Cargo.toml, etc. */
  all: DependencyMap;
  /** Source: which manifest file this came from */
  sources: string[];
}

export interface FileStructure {
  /** All file paths relative to repo root */
  files: string[];
  /** Directory names found (deduped) */
  directories: string[];
  /** Notable config files found */
  configFiles: string[];
}

export interface CodePatterns {
  /** pattern -> list of file:line locations where it was found */
  matches: Record<string, string[]>;
}

// ─── The full fingerprint produced by the scanner ───────────────────────────

export interface RepoFingerprint {
  meta: RepoMetadata;
  dependencies: DetectedDependencies;
  fileStructure: FileStructure;
  codePatterns: CodePatterns;
  /** Languages detected by file extension */
  languages: string[];
  /** True if we cloned locally for deep scan */
  deepScan: boolean;
  scannedAt: string;
}

// ─── Registry types (matches schema/entry.schema.yaml) ──────────────────────

export interface RegistryEntrySignals {
  dependencies: string[];
  file_patterns: string[];
  code_patterns: string[];
}

export interface AssayScore {
  fork_to_star_ratio: number;
  monthly_active_contributors: number;
  download_velocity: number | null;
  last_commit_days_ago: number;
  issue_quality_score: number;
  provenance_score: number;
  assay_score: number;
}

export interface RegistryEntry {
  id: string;
  name: string;
  repo: string;
  author: string;
  author_provenance: {
    description: string;
    known_orgs: string[];
    provenance_score: number;
  };
  category: Category;
  subcategory: string;
  problem_solved: string;
  languages: string[];
  assay: AssayScore;
  signals: RegistryEntrySignals;
  anti_signals: RegistryEntrySignals;
  relevance_note: string;
  meta: {
    added_by: string;
    added_date: string;
    verified: boolean;
    visibility: 'public' | 'org';
    org_id: string | null;
    registry_version: string;
  };
}

export type Category =
  | 'context-management'
  | 'prompt-engineering'
  | 'rag-retrieval'
  | 'testing-evals'
  | 'security'
  | 'observability'
  | 'agent-patterns';

export const CATEGORIES: Category[] = [
  'observability',
  'testing-evals',
  'security',
  'rag-retrieval',
  'context-management',
  'agent-patterns',
  'prompt-engineering',
];

export const CATEGORY_LABELS: Record<Category, string> = {
  'observability':      'Observability',
  'testing-evals':      'Testing & Evals',
  'security':           'Security',
  'rag-retrieval':      'RAG & Retrieval',
  'context-management': 'Context Management',
  'agent-patterns':     'Agent Patterns',
  'prompt-engineering': 'Prompt Engineering',
};

// ─── Match result ────────────────────────────────────────────────────────────

export interface MatchedSignal {
  type: 'dependency' | 'file_pattern' | 'code_pattern';
  value: string;
  locations?: string[];
}

export interface RecommendationResult {
  entry: RegistryEntry;
  matchedSignals: MatchedSignal[];
  /** Rendered relevance note with {signal} replaced */
  renderedNote: string;
  /** Whether an anti_signal was found (reduces confidence) */
  hasAntiSignal: boolean;
}

export interface CategoryResult {
  category: Category;
  label: string;
  recommendations: RecommendationResult[];
  /** True if no signals matched but category is relevant to the stack */
  isCovered: boolean;
  coverageNote?: string;
}

// ─── Final report ────────────────────────────────────────────────────────────

export interface PlumbReport {
  fingerprint: RepoFingerprint;
  categories: CategoryResult[];
  totalGaps: number;
  totalRecommendations: number;
  totalCovered: number;
  generatedAt: string;
  registryCommit: string;
}

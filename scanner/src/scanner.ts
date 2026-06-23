import type { ScanTarget, RepoFingerprint, PlumbReport } from './types';
import { GitHubApiReader } from './github/apiReader';
import { CloneReader } from './github/cloneReader';
import { RegistryLoader } from './readers/registryLoader';
import { Matcher } from './matchers/matcher';

// ─────────────────────────────────────────────────────────────────────────────
// PlumbScanner
//
// The main orchestrator. Coordinates the two-pass scan strategy:
//
//   Pass 1 (API):   Metadata + file tree + dependency manifests
//                   Fast, no cloning, respects rate limits
//
//   Pass 2 (Clone): Code pattern matching across source files
//                   Only triggered if registry entries have code_patterns
//                   that haven't been satisfied by Pass 1
//
// Usage:
//   const scanner = new PlumbScanner({ registryDir: './registry/entries' });
//   const report = await scanner.scan({ input: 'https://github.com/org/repo' });
// ─────────────────────────────────────────────────────────────────────────────

export interface ScannerOptions {
  /** Path to local registry YAML directory */
  registryDir?: string;
  /** Path to bundled registry JSON (production) */
  registryJson?: string;
  /** GitHub PAT for higher rate limits */
  githubToken?: string;
  /** Enterprise org ID for private registry access */
  orgId?: string;
  /** Force a deep clone scan even if API scan is sufficient */
  forceDeepScan?: boolean;
  /** Skip the clone pass entirely (faster, misses code patterns) */
  apiOnly?: boolean;
  /** Progress callback */
  onProgress?: (step: string) => void;
}

export class PlumbScanner {
  private registry: RegistryLoader;
  private options: ScannerOptions;

  constructor(options: ScannerOptions = {}) {
    this.options = options;
    this.registry = new RegistryLoader();

    if (options.registryJson) {
      this.registry.loadBundled(options.registryJson);
    } else if (options.registryDir) {
      this.registry.loadLocal(options.registryDir);
    }
  }

  async scan(target: ScanTarget): Promise<PlumbReport> {
    const progress = this.options.onProgress ?? (() => {});

    // ── Resolve target ──────────────────────────────────────────────────

    const parsed = GitHubApiReader.parseUrl(target.input);
    if (!parsed) {
      throw new Error(
        `Cannot parse "${target.input}" as a GitHub URL. ` +
        `Expected format: https://github.com/owner/repo or owner/repo`
      );
    }

    const { owner, repo } = parsed;
    const apiReader = new GitHubApiReader(target.token ?? this.options.githubToken);

    // ── Pass 1: API scan ────────────────────────────────────────────────

    progress('Fetching repository metadata...');
    const meta = await apiReader.fetchMetadata(owner, repo, target.ref);

    progress('Walking file tree...');
    const fileStructure = await apiReader.fetchFileTree(owner, repo, meta.commit);

    progress('Reading dependency manifests...');
    const dependencies = await apiReader.fetchDependencies(
      owner, repo, meta.commit, fileStructure.files
    );

    const languages = GitHubApiReader.detectLanguages(fileStructure.files);

    // Build a partial fingerprint to determine if Pass 2 is needed
    const partialFingerprint: RepoFingerprint = {
      meta,
      dependencies,
      fileStructure,
      codePatterns: { matches: {} },
      languages,
      deepScan: false,
      scannedAt: new Date().toISOString(),
    };

    // ── Determine if Pass 2 (clone) is needed ───────────────────────────
    //
    // We only clone if:
    //   a) apiOnly is not set, AND
    //   b) At least one registry entry has code_patterns that haven't
    //      been satisfied by dependency or file signals, AND the
    //      registry entries for those patterns are likely relevant
    //      given what we already know about the repo.

    const needsDeepScan =
      !this.options.apiOnly &&
      (this.options.forceDeepScan || this.hasUnsatisfiedCodePatterns(partialFingerprint));

    let fingerprint = partialFingerprint;

    if (needsDeepScan) {
      progress('Deep scan: cloning repository for code pattern analysis...');
      const cloneReader = new CloneReader();

      try {
        const repoPath = await cloneReader.clone(
          `https://github.com/${owner}/${repo}.git`,
          target.ref
        );

        const codePatterns = await cloneReader.scanCodePatterns(
          repoPath,
          this.collectCodePatterns()
        );

        fingerprint = {
          ...partialFingerprint,
          codePatterns,
          deepScan: true,
        };
      } finally {
        cloneReader.cleanup();
      }
    }

    // ── Match against registry ──────────────────────────────────────────

    progress('Matching against Assay registry...');
    const matcher = new Matcher(this.registry, this.options.orgId);
    return matcher.match(fingerprint);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private collectCodePatterns(): string[] {
    const entries = this.registry.getEntries(this.options.orgId);
    const patterns = new Set<string>();
    for (const entry of entries) {
      for (const p of entry.signals.code_patterns) {
        patterns.add(p);
      }
    }
    return Array.from(patterns);
  }

  private hasUnsatisfiedCodePatterns(fp: RepoFingerprint): boolean {
    const entries = this.registry.getEntries(this.options.orgId);
    for (const entry of entries) {
      if (entry.signals.code_patterns.length > 0) {
        // Check if this entry is plausibly relevant before cloning
        const depMatch = entry.signals.dependencies.some(dep =>
          Object.keys(fp.dependencies.all)
            .some(d => d.toLowerCase().includes(dep.toLowerCase()))
        );
        if (depMatch || entry.signals.dependencies.length === 0) return true;
      }
    }
    return false;
  }
}

// Re-export types for consumers
export type { ScanTarget, PlumbReport, RepoFingerprint } from './types';

import type {
  RepoFingerprint,
  RegistryEntry,
  RecommendationResult,
  CategoryResult,
  MatchedSignal,
  Category,
  PlumbReport,
} from '../types';
import { CATEGORIES, CATEGORY_LABELS } from '../types';
import { RegistryLoader } from '../readers/registryLoader';

// ─────────────────────────────────────────────────────────────────────────────
// Matcher
//
// Takes a RepoFingerprint and a loaded RegistryLoader, cross-references
// every registry entry's signals against the fingerprint, and returns
// a structured PlumbReport.
//
// Matching logic:
//   A registry entry is recommended if ANY of its signals match.
//   An entry is suppressed if ANY of its anti_signals match (already covered).
//   Matched signals are returned so the report card can explain why.
// ─────────────────────────────────────────────────────────────────────────────

export class Matcher {
  constructor(private registry: RegistryLoader, private orgId?: string) {}

  match(fingerprint: RepoFingerprint): PlumbReport {
    const entries = this.registry.getEntries(this.orgId);
    const categoryResults: CategoryResult[] = [];

    let totalGaps = 0;
    let totalRecommendations = 0;
    let totalCovered = 0;

    for (const category of CATEGORIES) {
      const categoryEntries = entries.filter(e => e.category === category);
      const recommendations: RecommendationResult[] = [];

      for (const entry of categoryEntries) {
        // Skip entries for languages not present in this repo
        if (!this.languageMatches(entry, fingerprint)) continue;

        const antiSignalHit = this.checkAntiSignals(entry, fingerprint);
        const { matched, signals } = this.checkSignals(entry, fingerprint);

        if (!matched) continue;

        const renderedNote = this.renderNote(entry.relevance_note, signals);

        recommendations.push({
          entry,
          matchedSignals: signals,
          renderedNote,
          hasAntiSignal: antiSignalHit,
        });
      }

      // Sort by Assay score descending
      recommendations.sort(
        (a, b) => b.entry.assay.assay_score - a.entry.assay.assay_score
      );

      // Determine category status
      const isCovered = this.isCategoryCovered(category, fingerprint, entries);
      const coverageNote = isCovered
        ? this.buildCoverageNote(category, fingerprint)
        : undefined;

      if (recommendations.length > 0) {
        totalRecommendations += recommendations.length;
      }
      if (isCovered && recommendations.length === 0) {
        totalCovered++;
      }
      if (!isCovered && recommendations.length === 0) {
        // Category is relevant but nothing matched — still a gap, no recs
      }
      if (recommendations.length > 0 && !isCovered) {
        totalGaps++;
      }

      categoryResults.push({
        category,
        label: CATEGORY_LABELS[category],
        recommendations,
        isCovered,
        coverageNote,
      });
    }

    return {
      fingerprint,
      categories: categoryResults,
      totalGaps,
      totalRecommendations,
      totalCovered,
      generatedAt: new Date().toISOString(),
      registryCommit: this.registry.getCommit(),
    };
  }

  // ── Signal matching ─────────────────────────────────────────────────────

  private checkSignals(
    entry: RegistryEntry,
    fp: RepoFingerprint,
  ): { matched: boolean; signals: MatchedSignal[] } {
    const signals: MatchedSignal[] = [];

    // 1. Dependency signals
    for (const dep of entry.signals.dependencies) {
      const normalized = dep.toLowerCase();
      const found = Object.keys(fp.dependencies.all).find(
        d => d.toLowerCase() === normalized || d.toLowerCase().includes(normalized)
      );
      if (found) {
        signals.push({ type: 'dependency', value: found });
      }
    }

    // 2. File pattern signals
    for (const pattern of entry.signals.file_patterns) {
      const matched = fp.fileStructure.files.find(
        f => f === pattern || f.startsWith(pattern) || f.endsWith(pattern)
      ) ?? fp.fileStructure.configFiles.find(
        f => f === pattern || f.includes(pattern)
      );
      if (matched) {
        signals.push({ type: 'file_pattern', value: matched });
      }
    }

    // 3. Code pattern signals (populated only on deep scan)
    for (const pattern of entry.signals.code_patterns) {
      const locations = fp.codePatterns.matches[pattern];
      if (locations && locations.length > 0) {
        signals.push({ type: 'code_pattern', value: pattern, locations });
      }
    }

    return { matched: signals.length > 0, signals };
  }

  // ── Anti-signal matching ────────────────────────────────────────────────

  private checkAntiSignals(entry: RegistryEntry, fp: RepoFingerprint): boolean {
    // Dependency anti-signals
    for (const dep of entry.anti_signals.dependencies) {
      const found = Object.keys(fp.dependencies.all).find(
        d => d.toLowerCase() === dep.toLowerCase()
      );
      if (found) return true;
    }

    // File pattern anti-signals
    for (const pattern of entry.anti_signals.file_patterns) {
      const found = fp.fileStructure.files.find(
        f => f === pattern || f.includes(pattern)
      );
      if (found) return true;
    }

    return false;
  }

  // ── Language filter ─────────────────────────────────────────────────────
  //
  // If a registry entry specifies languages, at least one must be present
  // in the repo. Entries with no language constraint match everything.

  private languageMatches(entry: RegistryEntry, fp: RepoFingerprint): boolean {
    if (!entry.languages || entry.languages.length === 0) return true;
    return entry.languages.some(lang =>
      fp.languages.map(l => l.toLowerCase()).includes(lang.toLowerCase())
    );
  }

  // ── Coverage detection ──────────────────────────────────────────────────
  //
  // Determines if a category is already "covered" — i.e. the repo is using
  // a known solution for this category, so no recommendation is needed.

  private isCategoryCovered(
    category: Category,
    fp: RepoFingerprint,
    entries: RegistryEntry[],
  ): boolean {
    const categoryEntries = entries.filter(e => e.category === category);
    for (const entry of categoryEntries) {
      if (this.checkAntiSignals(entry, fp)) return true;
    }
    return false;
  }

  private buildCoverageNote(category: Category, fp: RepoFingerprint): string {
    const notes: Partial<Record<Category, string>> = {
      'agent-patterns': 'Agent orchestration patterns detected in your dependencies.',
      'prompt-engineering': 'Structured output patterns detected in your codebase.',
      'observability': 'An observability solution is already present.',
      'context-management': 'A memory or context management layer is already present.',
    };
    return notes[category] ?? `${CATEGORY_LABELS[category]} is already covered.`;
  }

  // ── Relevance note rendering ────────────────────────────────────────────
  //
  // Replaces {signal} in the note template with the most specific matched
  // signal — code patterns first (most specific), then files, then deps.

  private renderNote(template: string, signals: MatchedSignal[]): string {
    const best =
      signals.find(s => s.type === 'code_pattern') ??
      signals.find(s => s.type === 'file_pattern') ??
      signals[0];

    if (!best) return template;
    return template.replace(/\{signal\}/g, best.value);
  }
}

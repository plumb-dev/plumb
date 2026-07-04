import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RegistryLoader } from '../readers/registryLoader';
import { Matcher } from './matcher';
import type { Category, RegistryEntry, RepoFingerprint } from '../types';

// ── fixtures ─────────────────────────────────────────────────────────────────

interface EntryOpts {
  signals?: Partial<RegistryEntry['signals']>;
  anti_signals?: Partial<RegistryEntry['anti_signals']>;
  languages?: string[];
  assayScore?: number;
  relevance_note?: string;
}

function entry(id: string, category: Category, o: EntryOpts = {}): RegistryEntry {
  return {
    id, name: id, repo: `https://github.com/x/${id}`, author: 'x',
    author_provenance: { description: '', known_orgs: [], provenance_score: 3 },
    category, subcategory: 'sub', problem_solved: 'does a thing', languages: o.languages ?? [],
    assay: {
      fork_to_star_ratio: 0.1, monthly_active_contributors: 5, download_velocity: 1000,
      last_commit_days_ago: 1, issue_quality_score: 3, provenance_score: 3,
      assay_score: o.assayScore ?? 70,
    },
    signals: { dependencies: [], file_patterns: [], code_patterns: [], ...o.signals },
    anti_signals: { dependencies: [], file_patterns: [], code_patterns: [], ...o.anti_signals },
    relevance_note: o.relevance_note ?? 'Your {signal} needs this.',
    meta: {
      added_by: 't', added_date: '2026-01-01', verified: true,
      visibility: 'public', org_id: null, registry_version: '1.0.0',
    },
  };
}

function loadWith(entries: RegistryEntry[]): RegistryLoader {
  const tmp = path.join(os.tmpdir(), `plumb-reg-${Date.now()}-${Math.random()}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ commit: 'test', entries }));
  const loader = new RegistryLoader();
  loader.loadBundled(tmp);
  fs.unlinkSync(tmp);
  return loader;
}

function fingerprint(o: {
  deps?: Record<string, string>; files?: string[]; configFiles?: string[];
  codeMatches?: Record<string, string[]>; languages?: string[]; deepScan?: boolean;
} = {}): RepoFingerprint {
  return {
    meta: {
      name: 'r', fullName: 'o/r', description: null, defaultBranch: 'main',
      language: null, topics: [], url: '', commit: 'abc1234',
    },
    dependencies: { all: o.deps ?? {}, sources: [] },
    fileStructure: { files: o.files ?? [], directories: [], configFiles: o.configFiles ?? [] },
    codePatterns: { matches: o.codeMatches ?? {} },
    languages: o.languages ?? [],
    deepScan: o.deepScan ?? false,
    scannedAt: '',
  };
}

const recsFor = (report: ReturnType<Matcher['match']>, cat: Category) =>
  report.categories.find(c => c.category === cat)!.recommendations;

// ── tests ────────────────────────────────────────────────────────────────────

test('recommends an entry when a dependency signal matches', () => {
  const m = new Matcher(loadWith([entry('trace', 'observability', { signals: { dependencies: ['anthropic'] } })]));
  const report = m.match(fingerprint({ deps: { anthropic: '^0.50.0' } }));
  const recs = recsFor(report, 'observability');
  assert.equal(recs.length, 1);
  assert.equal(recs[0].entry.id, 'trace');
  assert.equal(report.totalRecommendations, 1);
});

test('does not recommend when no signal matches', () => {
  const m = new Matcher(loadWith([entry('trace', 'observability', { signals: { dependencies: ['openai'] } })]));
  const recs = recsFor(m.match(fingerprint({ deps: { django: '5' } })), 'observability');
  assert.equal(recs.length, 0);
});

test('renders {signal} with the matched value', () => {
  const m = new Matcher(loadWith([entry('trace', 'observability', {
    signals: { dependencies: ['anthropic'] }, relevance_note: 'Your {signal} has no tracing.',
  })]));
  const recs = recsFor(m.match(fingerprint({ deps: { anthropic: '1' } })), 'observability');
  assert.equal(recs[0].renderedNote, 'Your anthropic has no tracing.');
});

test('code-pattern locations flow through and win the {signal} slot', () => {
  const m = new Matcher(loadWith([entry('e', 'observability', {
    signals: { dependencies: ['anthropic'], code_patterns: ['client.messages.create'] },
    relevance_note: 'Your {signal} is untraced.',
  })]));
  const recs = recsFor(m.match(fingerprint({
    deps: { anthropic: '1' },
    codeMatches: { 'client.messages.create': ['backend/chat.py:10'] },
    deepScan: true,
  })), 'observability');
  const code = recs[0].matchedSignals.find(s => s.type === 'code_pattern');
  assert.deepEqual(code?.locations, ['backend/chat.py:10']);
  assert.equal(recs[0].renderedNote, 'Your client.messages.create is untraced.'); // code pattern preferred
});

test('anti-signal marks the category covered and yields no recommendation', () => {
  const m = new Matcher(loadWith([entry('mem', 'context-management', {
    signals: { dependencies: ['anthropic'] }, anti_signals: { dependencies: ['mem0'] },
  })]));
  const report = m.match(fingerprint({ deps: { mem0: '1' } })); // anti-signal present, no signal
  const cat = report.categories.find(c => c.category === 'context-management')!;
  assert.equal(cat.recommendations.length, 0);
  assert.equal(cat.isCovered, true);
  assert.equal(report.totalCovered, 1);
});

test('language filter excludes entries whose languages are absent', () => {
  const m = new Matcher(loadWith([entry('py', 'security', {
    signals: { dependencies: ['anthropic'] }, languages: ['python'],
  })]));
  const recs = recsFor(m.match(fingerprint({ deps: { anthropic: '1' }, languages: ['typescript'] })), 'security');
  assert.equal(recs.length, 0);
});

test('recommendations are sorted by assay score descending', () => {
  const m = new Matcher(loadWith([
    entry('low', 'observability', { signals: { dependencies: ['anthropic'] }, assayScore: 55 }),
    entry('high', 'observability', { signals: { dependencies: ['anthropic'] }, assayScore: 90 }),
  ]));
  const recs = recsFor(m.match(fingerprint({ deps: { anthropic: '1' } })), 'observability');
  assert.deepEqual(recs.map(r => r.entry.id), ['high', 'low']);
});

test('org-visibility entries are excluded unless the scan is for that org', () => {
  const orgEntry = entry('secret', 'observability', { signals: { dependencies: ['anthropic'] } });
  orgEntry.meta.visibility = 'org';
  orgEntry.meta.org_id = 'acme';
  const loader = loadWith([orgEntry]);
  const fp = fingerprint({ deps: { anthropic: '1' } });
  assert.equal(recsFor(new Matcher(loader).match(fp), 'observability').length, 0); // no orgId
  assert.equal(recsFor(new Matcher(loader, 'acme').match(fp), 'observability').length, 1); // matching orgId
});

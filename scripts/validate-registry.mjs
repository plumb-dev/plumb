// Validates every registry entry against the schema invariants. Run in CI so a
// malformed or under-specified entry can't merge. Exits non-zero on any error.
//
//   node scripts/validate-registry.mjs
import fs from 'fs';
import path from 'path';
import { parse } from 'yaml';

const ENTRIES_DIR = path.resolve('registry/entries');
const TEMPLATES = new Set(['examples.yaml', 'examples.yml']);
const CATEGORIES = new Set([
  'observability', 'testing-evals', 'security', 'rag-retrieval',
  'context-management', 'agent-patterns', 'prompt-engineering',
]);

const errors = [];
const seenIds = new Map(); // id -> file

const files = fs.readdirSync(ENTRIES_DIR)
  .filter(f => (f.endsWith('.yaml') || f.endsWith('.yml')) && !TEMPLATES.has(f));

let count = 0;
for (const file of files) {
  const parsed = parse(fs.readFileSync(path.join(ENTRIES_DIR, file), 'utf8'));
  const entries = Array.isArray(parsed) ? parsed : [parsed];

  entries.forEach((e, i) => {
    const where = `${file}[${i}]${e?.id ? ` id=${e.id}` : ''}`;
    const err = (msg) => errors.push(`${where}: ${msg}`);
    count++;

    if (!e || typeof e !== 'object') return err('not an object');
    for (const f of ['id', 'name', 'repo', 'author', 'subcategory', 'problem_solved', 'relevance_note']) {
      if (typeof e[f] !== 'string' || !e[f].trim()) err(`missing/empty string field "${f}"`);
    }
    if (!CATEGORIES.has(e.category)) err(`invalid category "${e.category}"`);
    if (typeof e.repo === 'string' && !e.repo.startsWith('https://github.com/')) {
      err(`repo must be a github.com URL`);
    }
    if (typeof e.id === 'string') {
      if (seenIds.has(e.id)) err(`duplicate id (also in ${seenIds.get(e.id)})`);
      else seenIds.set(e.id, file);
    }

    // assay
    const a = e.assay;
    if (!a || typeof a !== 'object') err('missing assay block');
    else {
      if (typeof a.assay_score !== 'number' || a.assay_score < 0 || a.assay_score > 100) {
        err('assay.assay_score must be a number 0–100');
      }
    }

    // signals + anti_signals: both must exist with array members (CLAUDE.md invariant)
    for (const key of ['signals', 'anti_signals']) {
      const s = e[key];
      if (!s || typeof s !== 'object') { err(`missing ${key}`); continue; }
      if (!Array.isArray(s.dependencies)) err(`${key}.dependencies must be an array`);
      if (!Array.isArray(s.file_patterns)) err(`${key}.file_patterns must be an array`);
    }
    if (e.signals && Array.isArray(e.signals.dependencies) && Array.isArray(e.signals.file_patterns) &&
        Array.isArray(e.signals.code_patterns) &&
        e.signals.dependencies.length + e.signals.file_patterns.length + e.signals.code_patterns.length === 0) {
      err('signals is empty — an entry needs at least one signal');
    }

    // meta.visibility
    const vis = e.meta?.visibility;
    if (vis !== 'public' && vis !== 'org') err(`meta.visibility must be "public" or "org"`);
    if (vis === 'org' && !e.meta?.org_id) err('org entries require meta.org_id');
  });
}

if (errors.length) {
  console.error(`✗ registry validation failed (${errors.length} error(s) across ${count} entries):\n`);
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}
console.log(`✓ registry valid — ${count} entries across ${files.length} file(s)`);

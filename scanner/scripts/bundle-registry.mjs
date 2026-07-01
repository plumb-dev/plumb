// Snapshots the community registry into scanner/registry.bundled.json so the
// published @plumb/scanner package can score repos without the monorepo tree.
// Run from the scanner/ package dir (npm run bundle) — reads ../registry/entries.
//
// Excludes template files (examples.yaml) and any private enterprise entries
// (visibility: org) — the public bundle must never carry org-scoped data.
import fs from 'fs';
import path from 'path';
import { parse } from 'yaml';

const entriesDir = path.resolve(process.cwd(), '..', 'registry', 'entries');
const outPath = path.resolve(process.cwd(), 'registry.bundled.json');
const TEMPLATES = new Set(['examples.yaml', 'examples.yml']);

const files = fs.readdirSync(entriesDir)
  .filter(f => (f.endsWith('.yaml') || f.endsWith('.yml')) && !TEMPLATES.has(f));

const seen = new Set();
const entries = [];
for (const file of files) {
  const parsed = parse(fs.readFileSync(path.join(entriesDir, file), 'utf8'));
  for (const e of (Array.isArray(parsed) ? parsed : [parsed])) {
    if (!e || typeof e.id !== 'string') continue;
    if (e.meta?.visibility === 'org') continue; // never bundle private entries
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    entries.push(e);
  }
}

const snapshot = { commit: `bundled-${new Date().toISOString().slice(0, 10)}`, entries };
fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
console.log(`bundled ${entries.length} entries → ${path.relative(process.cwd(), outPath)}`);

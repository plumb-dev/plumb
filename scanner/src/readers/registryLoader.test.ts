import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RegistryLoader } from './registryLoader';

// Minimal valid entry YAML (passes validateEntry).
const yamlEntry = (id: string, visibility = 'public', orgId: string | null = null) =>
  `- id: ${id}
  name: "${id}"
  repo: https://github.com/x/${id}
  category: observability
  problem_solved: does a thing
  signals: { dependencies: [], file_patterns: [], code_patterns: [] }
  meta: { visibility: ${visibility}, org_id: ${orgId === null ? 'null' : orgId} }
`;

function tmpRegistry(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plumb-reg-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

test('skips template files (examples.yaml) and dedupes by id', () => {
  const dir = tmpRegistry({
    'a.yaml': yamlEntry('A'),
    'b.yaml': yamlEntry('A') + yamlEntry('B'), // A duplicates a.yaml
    'examples.yaml': yamlEntry('C'),           // template — must be skipped
  });
  const loader = new RegistryLoader();
  loader.loadLocal(dir);
  const ids = loader.getEntries().map(e => e.id).sort();
  assert.deepEqual(ids, ['A', 'B']); // one A (deduped), B, no C (template skipped)
});

test('org entries only returned for the matching orgId', () => {
  const dir = tmpRegistry({
    'seed.yaml': yamlEntry('pub') + yamlEntry('priv', 'org', 'acme'),
  });
  const loader = new RegistryLoader();
  loader.loadLocal(dir);
  assert.deepEqual(loader.getEntries().map(e => e.id), ['pub']);          // public only
  assert.deepEqual(loader.getEntries('acme').map(e => e.id).sort(), ['priv', 'pub']);
  assert.deepEqual(loader.getEntries('other').map(e => e.id), ['pub']);   // wrong org
});

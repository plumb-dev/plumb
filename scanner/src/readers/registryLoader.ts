import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'yaml';
import type { RegistryEntry, Category } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Registry Loader
//
// Loads RegistryEntry objects from YAML files. In production this will
// pull from a versioned GitHub release of the community registry.
// In development it reads from the local registry/entries/ directory.
// ─────────────────────────────────────────────────────────────────────────────

const REGISTRY_REMOTE_URL =
  'https://raw.githubusercontent.com/plumb-dev/registry/main/registry/entries/';

export class RegistryLoader {
  private entries: RegistryEntry[] = [];
  private commit = 'local';

  // ── Load from local directory (dev) ────────────────────────────────────

  loadLocal(registryDir: string): void {
    const yamlFiles = fs
      .readdirSync(registryDir)
      .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));

    for (const file of yamlFiles) {
      const content = fs.readFileSync(path.join(registryDir, file), 'utf-8');
      const parsed = parse(content);

      // Files may contain a single entry or an array
      const raw = Array.isArray(parsed) ? parsed : [parsed];
      for (const entry of raw) {
        if (this.validateEntry(entry)) {
          this.entries.push(entry as RegistryEntry);
        }
      }
    }

    this.commit = 'local-' + Date.now();
  }

  // ── Load from bundled registry (production) ─────────────────────────────
  //
  // In the VS Code extension and CLI release, the registry is bundled as
  // a JSON snapshot at build time and updated on a background schedule.

  loadBundled(jsonPath: string): void {
    const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    this.entries = raw.entries;
    this.commit = raw.commit;
  }

  // ── Filter by org visibility ────────────────────────────────────────────

  getEntries(orgId?: string): RegistryEntry[] {
    return this.entries.filter(e => {
      if (e.meta.visibility === 'public') return true;
      if (e.meta.visibility === 'org' && e.meta.org_id === orgId) return true;
      return false;
    });
  }

  getEntriesByCategory(category: Category, orgId?: string): RegistryEntry[] {
    return this.getEntries(orgId).filter(e => e.category === category);
  }

  getCommit(): string {
    return this.commit;
  }

  // ── Basic validation ────────────────────────────────────────────────────

  private validateEntry(entry: unknown): boolean {
    if (typeof entry !== 'object' || entry === null) return false;
    const e = entry as Record<string, unknown>;
    return (
      typeof e.id === 'string' &&
      typeof e.name === 'string' &&
      typeof e.repo === 'string' &&
      typeof e.category === 'string' &&
      typeof e.problem_solved === 'string' &&
      typeof e.signals === 'object'
    );
  }
}

# @plumb/scanner

The Plumb codebase scanner. Reads a GitHub repository and matches it against the Assay registry to produce a structured report card of AI engineering best practices.

## How it works

The scanner runs in two passes:

**Pass 1 — GitHub API.** Fetches repo metadata, walks the full file tree, and reads every dependency manifest (`package.json`, `requirements.txt`, `pyproject.toml`, `Cargo.toml`, `go.mod`, etc.). No cloning required. Fast.

**Pass 2 — Clone (when needed).** If registry entries have `code_patterns` that require reading source files directly, the scanner clones the repo to a temp directory, scans with regex, then cleans up. Only triggered when the API pass leaves code-level signals unresolved.

## CLI

```bash
# Basic scan
npx plumb scan https://github.com/acme/my-ai-app

# With a GitHub token (raises rate limit to 5,000 req/hr)
npx plumb scan acme/my-ai-app --token ghp_xxx

# API-only (faster, skips code pattern matching)
npx plumb scan acme/my-ai-app --api-only

# JSON output
npx plumb scan acme/my-ai-app --format json --output report.json

# Markdown report dropped into the repo
npx plumb scan acme/my-ai-app --format markdown --output PLUMB.md

# Use a local registry directory (for development)
npx plumb scan acme/my-ai-app --registry ./registry/entries
```

Set `GITHUB_TOKEN` in your environment to avoid passing `--token` on every invocation.

## Library API

```typescript
import { PlumbScanner } from '@plumb/scanner';

const scanner = new PlumbScanner({
  githubToken: process.env.GITHUB_TOKEN,
  registryDir: './registry/entries',
});

const report = await scanner.scan({
  input: 'https://github.com/acme/my-ai-app',
});

for (const cat of report.categories) {
  console.log(cat.label, cat.recommendations.length, 'recommendations');
  for (const rec of cat.recommendations) {
    console.log(' -', rec.entry.name, `(assay: ${rec.entry.assay.assay_score})`);
    console.log('  ', rec.renderedNote);
  }
}
```

## Output structure

```typescript
interface PlumbReport {
  fingerprint: RepoFingerprint;    // What the scanner found
  categories: CategoryResult[];    // Per-category results
  totalGaps: number;               // Categories with missing coverage
  totalRecommendations: number;    // Total repos recommended
  totalCovered: number;            // Categories already handled
  generatedAt: string;             // ISO timestamp
  registryCommit: string;          // Registry version used
}
```

## Rate limits

| Mode | Requests/hr | Notes |
|------|-------------|-------|
| Unauthenticated | 60 | Enough for a single scan of a small repo |
| Authenticated | 5,000 | Set `GITHUB_TOKEN` or pass `--token` |

Large repos (500+ files) may require an authenticated token even for a single scan due to the paginated tree fetch.

## Enterprise private registries

Pass `orgId` to the scanner to include private registry entries alongside public ones:

```typescript
const scanner = new PlumbScanner({
  githubToken: process.env.GITHUB_TOKEN,
  registryJson: './enterprise-registry.json',  // bundled private registry
  orgId: 'acme-corp',
});
```

Private registry entries follow the same schema as public entries with `visibility: org` and an `org_id` field.

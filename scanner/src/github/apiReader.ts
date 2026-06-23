import { Octokit } from '@octokit/rest';
import type {
  ScanTarget,
  RepoMetadata,
  DetectedDependencies,
  FileStructure,
  DependencyMap,
} from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// GitHub API Reader
//
// Uses the GitHub REST API to:
//   1. Fetch repo metadata (name, topics, default branch, commit SHA)
//   2. Walk the file tree without cloning
//   3. Fetch and parse dependency manifests
//
// Rate limits:
//   Unauthenticated: 60 req/hr
//   Authenticated:   5,000 req/hr
//
// The scanner uses this as the first pass. If deep code pattern scanning
// is needed (code_patterns in registry signals), it falls back to a
// local clone via ../github/cloneReader.ts
// ─────────────────────────────────────────────────────────────────────────────

const MANIFEST_FILES = [
  'package.json',
  'requirements.txt',
  'pyproject.toml',
  'Pipfile',
  'Cargo.toml',
  'go.mod',
  'composer.json',
  'Gemfile',
  'build.gradle',
  'pom.xml',
];

/** Files whose presence alone is a signal (no content parsing needed) */
export const NOTABLE_CONFIG_FILES = [
  '.claude',
  'CLAUDE.md',
  'AGENTS.md',
  '.cursor',
  'evals/',
  'prompts/',
  'eval/',
  'tests/evals',
  'langfuse.config',
  'promptfoo.yaml',
  'promptfooconfig.yaml',
];

export class GitHubApiReader {
  private octokit: Octokit;

  constructor(token?: string) {
    this.octokit = new Octokit({ auth: token });
  }

  // ── Parse GitHub URL ────────────────────────────────────────────────────

  static parseUrl(url: string): { owner: string; repo: string } | null {
    const patterns = [
      /github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/,
      /^([^/]+)\/([^/]+)$/,
    ];
    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) return { owner: match[1], repo: match[2] };
    }
    return null;
  }

  // ── Repo metadata ───────────────────────────────────────────────────────

  async fetchMetadata(owner: string, repo: string, ref?: string): Promise<RepoMetadata> {
    const { data } = await this.octokit.repos.get({ owner, repo });

    // Resolve the commit SHA for the ref (or default branch)
    const branch = ref ?? data.default_branch;
    const { data: branchData } = await this.octokit.repos.getBranch({
      owner, repo, branch,
    });

    return {
      name: data.name,
      fullName: data.full_name,
      description: data.description,
      defaultBranch: data.default_branch,
      language: data.language ?? null,
      topics: data.topics ?? [],
      url: data.html_url,
      commit: branchData.commit.sha,
    };
  }

  // ── File tree ───────────────────────────────────────────────────────────

  async fetchFileTree(
    owner: string,
    repo: string,
    ref: string,
  ): Promise<FileStructure> {
    const { data } = await this.octokit.git.getTree({
      owner,
      repo,
      tree_sha: ref,
      recursive: '1',
    });

    const files: string[] = [];
    const directorySet = new Set<string>();
    const configFiles: string[] = [];

    for (const item of data.tree) {
      if (!item.path) continue;

      if (item.type === 'blob') {
        files.push(item.path);

        // Track parent directories
        const parts = item.path.split('/');
        for (let i = 1; i < parts.length; i++) {
          directorySet.add(parts.slice(0, i).join('/'));
        }

        // Flag notable config files
        for (const notable of NOTABLE_CONFIG_FILES) {
          if (item.path === notable || item.path.startsWith(notable)) {
            if (!configFiles.includes(item.path)) {
              configFiles.push(item.path);
            }
          }
        }
      }
    }

    return {
      files,
      directories: Array.from(directorySet),
      configFiles,
    };
  }

  // ── Dependency manifests ────────────────────────────────────────────────

  async fetchDependencies(
    owner: string,
    repo: string,
    ref: string,
    files: string[],
  ): Promise<DetectedDependencies> {
    const foundManifests = files.filter(f =>
      MANIFEST_FILES.some(m => f === m || f.endsWith('/' + m))
    );

    const all: DependencyMap = {};
    const sources: string[] = [];

    await Promise.allSettled(
      foundManifests.map(async (manifestPath) => {
        try {
          const content = await this.fetchFileContent(owner, repo, ref, manifestPath);
          const parsed = parseManifest(manifestPath, content);
          Object.assign(all, parsed);
          sources.push(manifestPath);
        } catch {
          // File may have been deleted between tree fetch and content fetch
        }
      })
    );

    return { all, sources };
  }

  // ── File content ────────────────────────────────────────────────────────

  async fetchFileContent(
    owner: string,
    repo: string,
    ref: string,
    path: string,
  ): Promise<string> {
    const { data } = await this.octokit.repos.getContent({
      owner, repo, path, ref,
    });

    if ('content' in data && data.encoding === 'base64') {
      return Buffer.from(data.content, 'base64').toString('utf-8');
    }
    throw new Error(`Cannot decode content of ${path}`);
  }

  // ── Language detection from file extensions ─────────────────────────────

  static detectLanguages(files: string[]): string[] {
    const extMap: Record<string, string> = {
      '.ts': 'typescript', '.tsx': 'typescript',
      '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript',
      '.py': 'python',
      '.rs': 'rust',
      '.go': 'go',
      '.java': 'java',
      '.rb': 'ruby',
      '.php': 'php',
      '.cs': 'csharp',
      '.ex': 'elixir', '.exs': 'elixir',
    };

    const found = new Set<string>();
    for (const file of files) {
      const ext = '.' + file.split('.').pop();
      const lang = extMap[ext];
      if (lang) found.add(lang);
    }
    return Array.from(found);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Manifest parsers
// ─────────────────────────────────────────────────────────────────────────────

function parseManifest(filename: string, content: string): DependencyMap {
  const base = filename.split('/').pop()!;

  try {
    if (base === 'package.json')        return parsePackageJson(content);
    if (base === 'requirements.txt')    return parseRequirementsTxt(content);
    if (base === 'pyproject.toml')      return parsePyprojectToml(content);
    if (base === 'Cargo.toml')          return parseCargoToml(content);
    if (base === 'go.mod')              return parseGoMod(content);
    if (base === 'Pipfile')             return parsePipfile(content);
  } catch {
    // Malformed manifest — return empty rather than crashing the scan
  }
  return {};
}

function parsePackageJson(content: string): DependencyMap {
  const json = JSON.parse(content);
  return {
    ...json.dependencies,
    ...json.devDependencies,
    ...json.peerDependencies,
  };
}

function parseRequirementsTxt(content: string): DependencyMap {
  const deps: DependencyMap = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;
    const match = trimmed.match(/^([a-zA-Z0-9_.\-]+)([>=<!,\s].*)?$/);
    if (match) deps[match[1].toLowerCase()] = match[2]?.trim() ?? '*';
  }
  return deps;
}

function parsePyprojectToml(content: string): DependencyMap {
  const deps: DependencyMap = {};
  // Extract from [project] dependencies and [tool.poetry.dependencies]
  const depSection = content.match(/dependencies\s*=\s*\[([\s\S]*?)\]/);
  if (depSection) {
    const matches = depSection[1].matchAll(/"([a-zA-Z0-9_.\-]+)([>=<!,\s].*)?"/g);
    for (const m of matches) deps[m[1].toLowerCase()] = m[2]?.trim() ?? '*';
  }
  return deps;
}

function parseCargoToml(content: string): DependencyMap {
  const deps: DependencyMap = {};
  const inDeps = /\[dependencies\]([\s\S]*?)(?=\[|$)/;
  const section = content.match(inDeps);
  if (section) {
    const matches = section[1].matchAll(/^([a-zA-Z0-9_\-]+)\s*=/gm);
    for (const m of matches) deps[m[1]] = '*';
  }
  return deps;
}

function parseGoMod(content: string): DependencyMap {
  const deps: DependencyMap = {};
  const matches = content.matchAll(/^\s+([^\s]+)\s+([^\s]+)/gm);
  for (const m of matches) deps[m[1]] = m[2];
  return deps;
}

function parsePipfile(content: string): DependencyMap {
  const deps: DependencyMap = {};
  const section = content.match(/\[packages\]([\s\S]*?)(?=\[|$)/);
  if (section) {
    const matches = section[1].matchAll(/^([a-zA-Z0-9_\-]+)\s*=/gm);
    for (const m of matches) deps[m[1].toLowerCase()] = '*';
  }
  return deps;
}

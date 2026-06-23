import { Octokit } from '@octokit/rest';
import { GitHubApiReader } from '../github/apiReader';
import type { RegistryEntry } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Assay Collector — live signal collection
//
// Gathers the four objective, automatable signals for a registry entry:
//   - fork_to_star_ratio        (GitHub repo)
//   - monthly_active_contributors (distinct commit authors in the last 30 days)
//   - download_velocity         (npm last-week + PyPI last-week)
//   - last_commit_days_ago      (default-branch HEAD date)
//
// Issue quality (LLM-scored) and provenance (human-set) are NOT collected here —
// the engine carries those forward from the registry entry. See docs/ASSAY.md.
// ─────────────────────────────────────────────────────────────────────────────

export interface RawSignals {
  stars: number;
  forks: number;
  forkToStarRatio: number;
  monthlyActiveContributors: number;
  lastCommitDaysAgo: number;
  /** Combined weekly downloads across npm + PyPI, or null if unpublished/unknown. */
  downloadVelocity: number | null;
  downloadSource: string | null;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const CONTRIBUTOR_PAGE_CAP = 3; // up to 300 recent commits is plenty to count distinct authors

export class AssayCollector {
  private octokit: Octokit;

  constructor(token?: string) {
    this.octokit = new Octokit({ auth: token });
  }

  async collect(entry: RegistryEntry): Promise<RawSignals> {
    const parsed = GitHubApiReader.parseUrl(entry.repo);
    if (!parsed) throw new Error(`Unparseable repo URL: ${entry.repo}`);
    const { owner, repo } = parsed;

    const [github, downloads] = await Promise.all([
      this.collectGitHub(owner, repo),
      this.collectDownloads(entry, owner, repo),
    ]);

    return { ...github, ...downloads };
  }

  // ── GitHub: stars, forks, recency, 30-day active contributors ─────────────

  private async collectGitHub(owner: string, repo: string): Promise<Omit<RawSignals, 'downloadVelocity' | 'downloadSource'>> {
    const { data: r } = await this.octokit.repos.get({ owner, repo });
    const stars = r.stargazers_count ?? 0;
    const forks = r.forks_count ?? 0;
    const ratio = stars > 0 ? forks / stars : 0;

    // Recency: date of the latest commit on the default branch.
    const { data: head } = await this.octokit.repos.listCommits({
      owner, repo, sha: r.default_branch, per_page: 1,
    });
    const lastCommitDate = head[0]?.commit?.committer?.date ?? head[0]?.commit?.author?.date;
    const lastCommitDaysAgo = lastCommitDate
      ? Math.floor((Date.now() - new Date(lastCommitDate).getTime()) / (24 * 60 * 60 * 1000))
      : 9999;

    // Active contributors: distinct authors of commits in the last 30 days.
    const since = new Date(Date.now() - THIRTY_DAYS_MS).toISOString();
    const authors = new Set<string>();
    for (let page = 1; page <= CONTRIBUTOR_PAGE_CAP; page++) {
      const { data: commits } = await this.octokit.repos.listCommits({
        owner, repo, sha: r.default_branch, since, per_page: 100, page,
      });
      for (const c of commits) {
        const key = c.author?.login ?? c.commit?.author?.email ?? c.commit?.author?.name;
        if (key) authors.add(key);
      }
      if (commits.length < 100) break; // last page reached
    }

    return {
      stars,
      forks,
      forkToStarRatio: ratio,
      monthlyActiveContributors: authors.size,
      lastCommitDaysAgo,
    };
  }

  // ── Package downloads: npm last-week + PyPI last-week ──────────────────────
  //
  // Package names are GUESSED from the repo, so every candidate is verified:
  // its registry `repository` link must point back to the entry's GitHub repo
  // before its downloads count. This rejects same-named but unrelated packages
  // (e.g. npm `skills` → vercel-labs/skills, not mattpocock/skills).

  private async collectDownloads(
    entry: RegistryEntry,
    owner: string,
    repo: string,
  ): Promise<Pick<RawSignals, 'downloadVelocity' | 'downloadSource'>> {
    // Honour explicit hints if an entry provides them (trusted, no verification).
    const hints = (entry.assay ?? {}) as unknown as Record<string, unknown>;
    const npmHint = typeof hints.npm === 'string' ? hints.npm : undefined;
    const pypiHint = typeof hints.pypi === 'string' ? hints.pypi : undefined;

    const langs = entry.languages ?? [];
    const wantsNpm = npmHint || langs.some(l => ['typescript', 'javascript', 'node'].includes(l));
    const wantsPypi = pypiHint || langs.includes('python');

    const sources: string[] = [];
    let total: number | null = null;

    if (wantsNpm) {
      const candidates = npmHint ? [npmHint] : npmCandidates(entry.author, repo);
      const n = await firstVerified(candidates, c => fetchNpmWeekly(c, owner, repo, !!npmHint));
      if (n) { total = (total ?? 0) + n.downloads; sources.push(`npm:${n.name}`); }
    }
    if (wantsPypi) {
      const candidates = pypiHint ? [pypiHint] : pypiCandidates(repo);
      const p = await firstVerified(candidates, c => fetchPypiWeekly(c, owner, repo, !!pypiHint));
      if (p) { total = (total ?? 0) + p.downloads; sources.push(`pypi:${p.name}`); }
    }

    return { downloadVelocity: total, downloadSource: sources.join(' + ') || null };
  }
}

// ── Candidate package names ────────────────────────────────────────────────

function npmCandidates(author: string, repo: string): string[] {
  const r = repo.toLowerCase();
  return dedupe([r, `@${author.toLowerCase()}/${r}`, r.replace(/[._]/g, '-')]);
}

function pypiCandidates(repo: string): string[] {
  const r = repo.toLowerCase();
  return dedupe([r, r.replace(/-/g, '_'), r.replace(/_/g, '-'), `${r}-ai`, `${r}ai`]);
}

const dedupe = (xs: string[]): string[] => Array.from(new Set(xs.filter(Boolean)));

async function firstVerified<T>(
  candidates: string[],
  fetcher: (name: string) => Promise<T | null>,
): Promise<T | null> {
  for (const name of candidates) {
    const hit = await fetcher(name);
    if (hit) return hit;
  }
  return null;
}

/** True if `url` references the given GitHub owner/repo (case-insensitive). */
function linksToRepo(url: string | undefined | null, owner: string, repo: string): boolean {
  if (!url) return false;
  const needle = `github.com/${owner}/${repo}`.toLowerCase();
  return url.toLowerCase().replace(/\.git\b/g, '').includes(needle);
}

// ── Registry HTTP clients ──────────────────────────────────────────────────

async function fetchNpmWeekly(
  name: string, owner: string, repo: string, trusted: boolean,
): Promise<{ name: string; downloads: number } | null> {
  try {
    // Verify the package belongs to this repo (skipped for explicit hints).
    if (!trusted) {
      const metaRes = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
      if (!metaRes.ok) return null;
      const meta = (await metaRes.json()) as { repository?: string | { url?: string } };
      const repoUrl = typeof meta.repository === 'string' ? meta.repository : meta.repository?.url;
      if (!linksToRepo(repoUrl, owner, repo)) return null;
    }
    const res = await fetch(`https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(name)}`);
    if (!res.ok) return null;
    const json = (await res.json()) as { downloads?: number; error?: string };
    if (json.error || typeof json.downloads !== 'number' || json.downloads === 0) return null;
    return { name, downloads: json.downloads };
  } catch {
    return null;
  }
}

async function fetchPypiWeekly(
  name: string, owner: string, repo: string, trusted: boolean,
): Promise<{ name: string; downloads: number } | null> {
  try {
    if (!trusted) {
      const metaRes = await fetch(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
      if (!metaRes.ok) return null;
      const meta = (await metaRes.json()) as {
        info?: { home_page?: string; project_urls?: Record<string, string> };
      };
      const urls = [
        meta.info?.home_page,
        ...Object.values(meta.info?.project_urls ?? {}),
      ];
      if (!urls.some(u => linksToRepo(u, owner, repo))) return null;
    }
    const res = await fetch(`https://pypistats.org/api/packages/${encodeURIComponent(name)}/recent`);
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { last_week?: number } };
    const weekly = json.data?.last_week;
    if (typeof weekly !== 'number' || weekly === 0) return null;
    return { name, downloads: weekly };
  } catch {
    return null;
  }
}

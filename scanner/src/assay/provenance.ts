// ─────────────────────────────────────────────────────────────────────────────
// Provenance scoring — automated from GitHub owner signals
//
// docs/ASSAY.md § 6 originally specified provenance as the one human-set signal.
// To scale past a hand-curated registry, this derives a defensible 1–5 from the
// repo owner's public GitHub footprint instead. It is overridable: an entry may
// set assay.provenance_override to pin a maintainer's judgment.
//
// Pure functions only (no I/O) — the collector supplies the OwnerProfile.
// ─────────────────────────────────────────────────────────────────────────────

export interface OwnerProfile {
  /** Account type of the repo owner. */
  type: 'User' | 'Organization';
  /** Account age in years. */
  ageYears: number;
  publicRepos: number;
  followers: number;
  /** GitHub "verified" badge (verified domain) — orgs only. */
  isVerified: boolean;
}

/**
 * 1–5 provenance score. Organizations earn credibility from being verified,
 * established, and prolific; personal accounts from a large following and a
 * long history. Tuned so a verified, established org → 5 and a brand-new
 * personal account → 1.
 */
export function provenanceScore(p: OwnerProfile): number {
  let s = 1;
  if (p.type === 'Organization') {
    s += 1;                              // an org is a stronger default than a person
    if (p.isVerified) s += 2;           // verified domain badge
    if (p.ageYears >= 3) s += 1;
    if (p.publicRepos >= 50) s += 1;
  } else {
    if (p.followers >= 5000) s += 3;
    else if (p.followers >= 1000) s += 2;
    else if (p.followers >= 200) s += 1;
    if (p.ageYears >= 5) s += 1;
  }
  return Math.min(5, Math.max(1, Math.round(s)));
}

/**
 * Whether the owner's credibility was confirmed via the GitHub API — the schema's
 * `author_provenance.auto_verified`. True for a verified org, or an established
 * org with a real repo footprint. Honest replacement for the hard-coded `true`.
 */
export function isAutoVerified(p: OwnerProfile): boolean {
  return p.type === 'Organization' && (p.isVerified || (p.ageYears >= 2 && p.publicRepos >= 10));
}

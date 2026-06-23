# The Assay Engine

Assay is Plumb's scoring engine. It runs on a scheduled basis against every entry in the registry and computes a composite trust score (0–100) from six signals. The score is displayed to developers in the report card alongside each recommendation.

## Why not just use stars

GitHub stars are a weak signal for real adoption and an actively gamed one. By mid-2024, over 16% of repositories with 50 or more stars were involved in fake star campaigns. The category most affected: AI and LLM projects. Assay does not use star counts as an input.

## The six signals

### 1. Fork-to-star ratio (weight: 20%)

Forks represent intent to use or modify. Stars represent a moment of interest. Healthy projects maintain a fork-to-star ratio between 0.10 and 0.25. Below 0.05 on a high-star repo is a flag.

Scored 0–100 using a sigmoid curve centered at 0.10. The centre was recalibrated from an initial 0.15 after the first live run over the seed registry: real AI/LLM repositories cluster between 0.06 and 0.18 (with mlflow at 0.22 a high outlier), so a 0.15 centre scored almost the entire category as mediocre. Centring at the observed band entry point (0.10 → 50) preserves the curve's intent — flagging genuinely low ratios — without penalising the field as a whole.

### 2. Monthly active contributors (weight: 25%)

Unique contributors with merged activity (commits, PRs, reviewed issues) in the last 30 days. A single-maintainer project with no outside contributors scores lower than one with a distributed contributor base.

Scored 0–100 using log scale. 1 contributor = ~10 points. 30+ contributors = ~90 points.

### 3. Download velocity (weight: 20%)

Weekly downloads from npm, PyPI, crates.io, or hex.pm where applicable. Null if the repo is not published as a package (e.g. a .claude skills directory). Null entries receive the category median score rather than zero, to avoid penalizing non-packaged tools.

Scored 0–100 using log scale against category median.

### 4. Last commit recency (weight: 10%)

Days since last commit to the default branch. An unmaintained repo is a liability in a fast-moving ecosystem.

| Days | Score |
|------|-------|
| 0–14 | 100 |
| 15–30 | 85 |
| 31–90 | 60 |
| 91–180 | 35 |
| 180+ | 10 |

### 5. Issue quality (weight: 12.5%)

Claude samples the last 50 closed issues and scores them on four criteria: presence of reproduction steps, version specificity, stack trace or error output, and evidence of resolution. Averaged to a 1–5 score, then normalized to 0–100.

Maintainers can override this score using `issue_quality_override` in the registry entry.

### 6. Provenance (weight: 12.5%)

A 1–5 score for author credibility, normalized to 0–100. **Computed** from the repo owner's GitHub footprint so the registry can scale past hand curation: organizations earn credibility from being verified (verified-domain badge), established, and prolific; personal accounts from a large following and long history (see `scanner/src/assay/provenance.ts` for the rubric).

Because the API measures the *owner account* — not reputation — a major project under a small or unverified org (e.g. a Databricks-origin tool living under its own lean org) can score mid-range. A maintainer can pin a deliberate value with `assay.provenance_override`, which the engine always prefers over the computed score. The companion `author_provenance.auto_verified` flag is set true only when owner credibility is confirmed via the API (a verified or established org), replacing the previously hard-coded value.

## Composite score

```
assay_score = (
  fork_to_star_ratio_score  * 0.20 +
  contributor_score         * 0.25 +
  download_score            * 0.20 +
  recency_score             * 0.10 +
  issue_quality_score       * 0.125 +
  provenance_score          * 0.125
)
```

Rounded to the nearest integer. Range: 0–100.

## Score interpretation

| Range | Meaning |
|-------|---------|
| 85–100 | Strong evidence of real production adoption. High confidence recommendation. |
| 70–84 | Good adoption signals. Minor gaps in one or two areas. |
| 55–69 | Moderate confidence. Useful but verify fit for your context. |
| 40–54 | Limited adoption evidence. Proceed with evaluation. |
| Below 40 | Insufficient signal. Entry is under review. |

## Scoring cadence

Assay runs every 72 hours against all public registry entries via the GitHub API and package registry APIs. Enterprise private registry entries are scored on the same cadence within the customer's own infrastructure.

## Implementation (v0.1)

The engine lives in `scanner/src/assay/` and runs via `cd scanner && npm run assay`
(dry-run) or `... assay --write` (persist). The scheduled run is wired in
`.github/workflows/assay.yml`.

What is automated vs. carried forward:

| Signal | v0.1 behaviour |
|--------|----------------|
| Fork-to-star ratio | **Live** — GitHub repo API |
| Monthly active contributors | **Live** — distinct authors of commits in the last 30 days on the default branch |
| Download velocity | **Live** — npm + PyPI last-week downloads |
| Last commit recency | **Live** — default-branch HEAD date |
| Issue quality | **Live (opt-in)** — `assay --issues` samples the last ~50 closed issues (Search API, `type:issue`) and scores them with Claude Haiku against the four § 5 criteria. Without `--issues`, carried forward from the entry (override wins). Needs `ANTHROPIC_API_KEY`. |
| Provenance | **Live** — heuristic from the owner's GitHub footprint (§ 6). Pin a maintainer value with `assay.provenance_override`. Also sets `auto_verified`. |

**Download verification.** Package names are guessed from the repo, so each
candidate is only counted if its registry `repository` link points back to the
entry's GitHub repo. This rejects same-named-but-unrelated packages. A package
whose registry metadata does not link to the repo is treated as unresolved, and
the entry receives the category-median download score (§3) rather than zero. An
entry may pin its package names with `assay.npm` / `assay.pypi` to skip guessing.

## Override policy

Any auto-computed score except provenance can be overridden by a maintainer using the corresponding `_override` field. Overrides are logged in the registry git history and visible to contributors. An override that materially changes a score triggers a mandatory re-review within 30 days.

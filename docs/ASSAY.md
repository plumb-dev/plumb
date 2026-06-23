# The Assay Engine

Assay is Plumb's scoring engine. It runs on a scheduled basis against every entry in the registry and computes a composite trust score (0–100) from six signals. The score is displayed to developers in the report card alongside each recommendation.

## Why not just use stars

GitHub stars are a weak signal for real adoption and an actively gamed one. By mid-2024, over 16% of repositories with 50 or more stars were involved in fake star campaigns. The category most affected: AI and LLM projects. Assay does not use star counts as an input.

## The six signals

### 1. Fork-to-star ratio (weight: 20%)

Forks represent intent to use or modify. Stars represent a moment of interest. Healthy projects maintain a fork-to-star ratio between 0.10 and 0.25. Below 0.05 on a high-star repo is a flag.

Scored 0–100 using a sigmoid curve centered at 0.15.

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

Set by a maintainer on a 1–5 scale per the rubric in CONTRIBUTING.md. Normalized to 0–100. This is the only signal that cannot be automated — it requires human judgment about author credibility and real-world adoption evidence.

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
| Issue quality | **Carried forward** from the entry — recomputing it needs an LLM pass and is not yet wired |
| Provenance | **Carried forward** — human-set, by design |

**Download verification.** Package names are guessed from the repo, so each
candidate is only counted if its registry `repository` link points back to the
entry's GitHub repo. This rejects same-named-but-unrelated packages. A package
whose registry metadata does not link to the repo is treated as unresolved, and
the entry receives the category-median download score (§3) rather than zero. An
entry may pin its package names with `assay.npm` / `assay.pypi` to skip guessing.

## Override policy

Any auto-computed score except provenance can be overridden by a maintainer using the corresponding `_override` field. Overrides are logged in the registry git history and visible to contributors. An override that materially changes a score triggers a mandatory re-review within 30 days.

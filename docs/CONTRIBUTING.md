# Contributing to the Plumb Registry

The Assay registry is community-maintained. Anyone can submit a repo for inclusion. Maintainers review every entry before it goes live.

## What belongs in the registry

A good registry entry solves a specific, recurring problem that developers building AI-assisted applications actually run into. The repo should be something a senior engineer would reach for in production, not something that looked impressive at launch.

Ask yourself: would I stake my team's codebase on this? If yes, submit it.

## What does not belong

- Repos with no production usage evidence
- Tools that duplicate an entry already in the registry
- Anything from a company you are affiliated with, unless you disclose it and a separate maintainer verifies it
- Tutorials, courses, or documentation repos (these are not tools)
- Anything primarily valued for its star count

## How to submit

1. Fork this repository
2. Copy `schema/entry.schema.yaml` into `registry/entries/your-entry-id.yaml`
3. Fill in every non-auto field
4. Leave all `assay:` fields blank — the Assay engine populates these on merge
5. Open a pull request with the title: `[registry] add: author-reponame`

## Provenance score guidance

The provenance score is the one field maintainers set by judgment. Use this rubric:

| Score | Criteria |
|-------|----------|
| 5 | Author is affiliated with a major AI lab, cloud provider, or well-known OSS org. Repo is a dependency of other verified projects. |
| 4 | Author has a credible public track record. Repo appears in production postmortems, conference talks, or peer-reviewed work. |
| 3 | Author is unknown but the repo has clear production usage evidence (download velocity, credible issue reporters, company names in issues). |
| 2 | Limited evidence of real adoption. Technically sound but unproven outside the author's own projects. |
| 1 | Author unknown, no external adoption evidence. Registry entry submitted by the author themselves. |

## Issue quality score guidance

The Assay engine scores this automatically by sampling closed issues. Maintainers can override with `issue_quality_override`. Use this rubric when overriding:

| Score | Criteria |
|-------|----------|
| 5 | Issues consistently include reproduction steps, version numbers, stack traces. Maintainer responses are substantive. Resolution is documented. |
| 4 | Most issues are well-formed. Some noise but signal is high. |
| 3 | Mixed quality. Production edge cases exist alongside low-effort reports. |
| 2 | Mostly low-effort reports. Few issues lead to meaningful resolution. |
| 1 | Issue tracker is effectively inactive or full of spam. |

## Updating an existing entry

Open a PR with the title: `[registry] update: author-reponame`

Include a brief note on what changed and why. Do not modify auto-computed `assay:` fields directly.

## Flagging an entry

If you believe an entry's Assay score is wrong, or the repo no longer meets the bar, open an issue with the title: `[flag] author-reponame` and describe the concern. Maintainers will re-review within 7 days.

## Enterprise private registries

Private org registries follow the same schema with two additional fields: `visibility: org` and `org_id`. Private entries are never visible to the community registry and are not subject to public review. Enterprise customers manage their own maintainer permissions through the Plumb dashboard.

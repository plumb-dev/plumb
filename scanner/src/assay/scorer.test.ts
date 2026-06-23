import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  forkToStarScore,
  contributorScore,
  downloadScore,
  recencyScore,
  normalizeFivePoint,
  compositeScore,
  WEIGHTS,
} from './scorer';
import { provenanceScore, isAutoVerified, type OwnerProfile } from './provenance';

// Run with: npm test  (node --test, type-stripped)

const near = (a: number, b: number, tol = 1.5) =>
  assert.ok(Math.abs(a - b) <= tol, `expected ${a} ≈ ${b} (±${tol})`);

test('weights sum to 1.0', () => {
  const sum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  near(sum, 1.0, 1e-9);
});

test('fork-to-star sigmoid is centred at 0.10 (recalibrated)', () => {
  near(forkToStarScore(0.10), 50);
  assert.ok(forkToStarScore(0.20) > forkToStarScore(0.10));
  assert.ok(forkToStarScore(0.02) < 25); // very low ratio → flagged
  assert.equal(forkToStarScore(-1), 0);
});

test('contributor log scale hits its anchors', () => {
  near(contributorScore(1), 10, 2);
  near(contributorScore(30), 90, 2);
  assert.equal(contributorScore(0), 0);
  assert.ok(contributorScore(100) <= 100);
});

test('download score is relative to the category median', () => {
  near(downloadScore(1000, 1000), 50); // at median
  near(downloadScore(10000, 1000), 75); // 10× median
  near(downloadScore(100, 1000), 25); // 0.1× median
  assert.equal(downloadScore(1000, 0), 50); // no basis → neutral
  assert.equal(downloadScore(0, 1000), 0);
});

test('recency step table', () => {
  assert.equal(recencyScore(0), 100);
  assert.equal(recencyScore(14), 100);
  assert.equal(recencyScore(20), 85);
  assert.equal(recencyScore(60), 60);
  assert.equal(recencyScore(120), 35);
  assert.equal(recencyScore(365), 10);
});

test('five-point normalisation', () => {
  assert.equal(normalizeFivePoint(5), 100);
  assert.equal(normalizeFivePoint(4), 80);
  assert.equal(normalizeFivePoint(0), 0);
});

test('provenance: verified established org → 5, brand-new personal → 1', () => {
  const org = (o: Partial<OwnerProfile>): OwnerProfile =>
    ({ type: 'Organization', ageYears: 5, publicRepos: 100, followers: 0, isVerified: true, ...o });
  assert.equal(provenanceScore(org({})), 5);
  assert.equal(provenanceScore(org({ isVerified: false })), 4); // strong but unverified org
  assert.equal(provenanceScore({ type: 'User', ageYears: 0.5, publicRepos: 2, followers: 3, isVerified: false }), 1);
  assert.ok(provenanceScore({ type: 'User', ageYears: 8, publicRepos: 40, followers: 9000, isVerified: false }) >= 4);
});

test('auto_verified only for credible orgs', () => {
  assert.equal(isAutoVerified({ type: 'Organization', ageYears: 5, publicRepos: 100, followers: 0, isVerified: true }), true);
  assert.equal(isAutoVerified({ type: 'Organization', ageYears: 3, publicRepos: 30, followers: 0, isVerified: false }), true);
  assert.equal(isAutoVerified({ type: 'User', ageYears: 10, publicRepos: 200, followers: 9000, isVerified: false }), false);
  assert.equal(isAutoVerified({ type: 'Organization', ageYears: 0.5, publicRepos: 1, followers: 0, isVerified: false }), false);
});

test('composite respects weights (all-100 → 100, all-0 → 0)', () => {
  const full = {
    forkToStar: 100, contributors: 100, downloads: 100,
    recency: 100, issueQuality: 100, provenance: 100,
  };
  assert.equal(compositeScore(full), 100);
  assert.equal(compositeScore({
    forkToStar: 0, contributors: 0, downloads: 0,
    recency: 0, issueQuality: 0, provenance: 0,
  }), 0);
  // A strong-but-stale repo should still score well, just not perfectly.
  const score = compositeScore({ ...full, recency: 10 });
  assert.ok(score > 88 && score < 100, `got ${score}`);
});

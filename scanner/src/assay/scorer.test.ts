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

// Run with: npm test  (node --test, type-stripped)

const near = (a: number, b: number, tol = 1.5) =>
  assert.ok(Math.abs(a - b) <= tol, `expected ${a} ≈ ${b} (±${tol})`);

test('weights sum to 1.0', () => {
  const sum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  near(sum, 1.0, 1e-9);
});

test('fork-to-star sigmoid is centred at 0.15', () => {
  near(forkToStarScore(0.15), 50);
  assert.ok(forkToStarScore(0.25) > forkToStarScore(0.15));
  assert.ok(forkToStarScore(0.05) < 20); // <0.05 is a flag → low score
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
